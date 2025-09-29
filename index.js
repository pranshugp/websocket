require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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

// --- Socket.IO connection & rooms ---
io.on('connection', (socket) => {
  const { userId, role, branch } = socket.handshake.auth || socket.handshake.query || {};
  console.log('✅ Socket connected:', socket.id, { userId, role, branch });

  if (userId) socket.join(userId.toString());           // private room
  if (role) socket.join(role);                          // role-based room
  if (branch) socket.join(`branch-${branch}`);          // branch-based room

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
