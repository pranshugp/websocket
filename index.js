require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || '';

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL ,
}));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL ,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
});

// --- Presence state (counsellor active/idle/on_call for super admin) ---
const presenceMap = new Map();
const ADMIN_ROOM = 'admin:presence';
const VALID_STATUSES = ['active', 'idle', 'on_call'];

function setPresence(userId, data) {
  const entry = {
    status: data.status || 'idle',
    name: data.name || null,
    branch: data.branch || null,
    updatedAt: Date.now(),
  };
  presenceMap.set(userId, entry);
  return entry;
}

function broadcastPresence(payload) {
  io.to(ADMIN_ROOM).emit('counsellor:presence', payload);
}

function updatePresenceFromHttp(userId, status, name = null, branch = null) {
  if (!VALID_STATUSES.includes(status)) return null;
  const entry = setPresence(userId, { status, name, branch });
  broadcastPresence({ userId, ...entry });
  return entry;
}

// --- Socket.IO connection & rooms ---
io.on('connection', (socket) => {
  const { userId, role, branch, name } = socket.handshake.auth || socket.handshake.query || {};
  const normalizedRole = (role || '').toLowerCase().replace(/[_ ]/g, '');
  console.log('✅ Socket connected:', socket.id, { userId, role, branch });

  if (userId) socket.join(userId.toString());           // private room
  if (role) socket.join(role);                          // role-based room
  if (branch) socket.join(`branch-${branch}`);          // branch-based room

  // --- Presence: super admin gets live counsellor status ---
  if (userId) {
    if (normalizedRole === 'superadmin') {
      socket.join(ADMIN_ROOM);
      console.log('🔹 Admin joined room:', ADMIN_ROOM);
      const snapshot = Array.from(presenceMap.entries()).map(([id, data]) => ({ userId: id, ...data }));
      socket.emit('counsellor:presence:snapshot', snapshot);
    } else if (['counsellor', 'telecaller', 'user'].includes(normalizedRole)) {
      const status = socket.handshake.auth?.status || socket.handshake.query?.status || 'active';
      const entry = setPresence(userId, { status, name, branch });
      broadcastPresence({ userId, ...entry });
      socket.on('counsellor:status', (payload) => {
        const s = VALID_STATUSES.includes(payload?.status) ? payload.status : 'active';
        const e = setPresence(userId, { status: s, name, branch });
        broadcastPresence({ userId, ...e });
      });
    }
  }

  socket.on('disconnect', (reason) => {
    console.log('❌ Socket disconnected:', socket.id, reason);
  });
});

// --- Helper to broadcast notifications ---
const broadcastNotification = ({
  notification,
  targetUserId,
  targetRole,
  targetBranch,
}) => {
  if (targetUserId) {
    io.to(targetUserId.toString()).emit('notification', notification);
  } else if (targetRole) {
    io.to(targetRole).emit('notification', notification);
  } else if (targetBranch) {
    io.to(`branch-${targetBranch}`).emit('notification', notification);
  } else {
    io.emit('notification', notification); // send to all
  }
};

// --- Test route ---
app.get("/test-notification", (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  broadcastNotification({
    notification: {
      _id: Date.now(),
      type: "test",
      title: "Test Notification",
      message: "🎉 This is a test notification!",
      createdAt: new Date(),
    },
    targetUserId: userId,
  });

  res.json({ success: true, sentTo: userId });
});
app.get("/", (req, res) => res.send("Socket server is running."));

// --- POST /presence – mobile app (Android/RN) reports active|idle|on_call ---
app.post('/presence', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization' });
  }
  const token = auth.slice(7);
  let decoded;
  try {
    decoded = JWT_SECRET ? jwt.verify(token, JWT_SECRET) : jwt.decode(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (!decoded?.id) return res.status(401).json({ error: 'Invalid token' });
  const status = ['active', 'idle', 'on_call'].includes(req.body?.status) ? req.body.status : 'active';
  updatePresenceFromHttp(decoded.id, status, decoded.name || req.body?.name, decoded.branch || req.body?.branch);
  return res.json({ ok: true, status });
});

// --- Emit via HTTP POST for all notifications (Global, Lead, Reminder, etc.) ---
app.post('/emit', (req, res) => {
  const { notification, targetUserId, targetRole, targetBranch } = req.body;
  if (!notification) return res.status(400).json({ error: "notification required" });

  console.log("📩 Emit API called:", req.body);

  broadcastNotification({ notification, targetUserId, targetRole, targetBranch });

  return res.json({ ok: true });
});

// --- Expose io instance for backend APIs to emit notifications ---
const getIO = () => io;

module.exports = { getIO };

// --- Start server ---
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Socket server listening on ${PORT}`));
