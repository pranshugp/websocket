require('dotenv').config();

// --- Startup assertion: fail hard if secrets are missing ---
if (!process.env.JWT_SECRET) {
  throw new Error('[FATAL] JWT_SECRET env var is required. Server will not start without it.');
}
if (!process.env.EMIT_SECRET) {
  throw new Error('[FATAL] EMIT_SECRET env var is required. Server will not start without it.');
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const JWT_SECRET = process.env.JWT_SECRET;
const EMIT_SECRET = process.env.EMIT_SECRET;

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL,
}));
app.use(express.json());

// --- Rate limiting ---
const presenceLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 60,                   // max 60 presence updates per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const emitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
});

// --- Presence state ---
const presenceMap = new Map();
const appPresenceMap = new Map();

// socketId -> { userId, isApp, normalizedRole } for clean disconnect
const socketMeta = new Map();

const ADMIN_ROOM = 'admin:presence';
const ADMIN_ROOM_APP = 'admin:presence:app';
const VALID_STATUSES = ['active', 'idle', 'on_call'];

// Stale-presence TTL: evict entries not updated in 5 minutes
const PRESENCE_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of presenceMap.entries()) {
    if (now - entry.updatedAt > PRESENCE_TTL_MS) {
      presenceMap.delete(userId);
      io.to(ADMIN_ROOM).emit('counsellor:presence:left', { userId });
    }
  }
  for (const [userId, entry] of appPresenceMap.entries()) {
    if (now - entry.updatedAt > PRESENCE_TTL_MS) {
      appPresenceMap.delete(userId);
      io.to(ADMIN_ROOM_APP).emit('counsellor:presence:left', { userId });
    }
  }
}, 60 * 1000);

function setPresence(userId, data) {
  const entry = {
    status: data.status || 'idle',
    name: data.name || null,
    branch: data.branch || null,
    updatedAt: Date.now(),
  };
  presenceMap.set(String(userId), entry);
  return entry;
}

function setAppPresence(userId, data) {
  const key = String(userId);
  const entry = {
    status: data.status || 'idle',
    name: data.name || null,
    branch: data.branch || null,
    updatedAt: Date.now(),
  };
  appPresenceMap.set(key, entry);
  return entry;
}

function removePresence(userId) {
  const key = String(userId);
  if (presenceMap.has(key)) {
    presenceMap.delete(key);
    io.to(ADMIN_ROOM).emit('counsellor:presence:left', { userId: key });
  }
}

function removeAppPresence(userId) {
  const key = String(userId);
  if (appPresenceMap.has(key)) {
    appPresenceMap.delete(key);
    io.to(ADMIN_ROOM_APP).emit('counsellor:presence:left', { userId: key });
  }
}

function broadcastPresence(payload) {
  io.to(ADMIN_ROOM).emit('counsellor:presence', payload);
}

function broadcastAppPresence(payload) {
  io.to(ADMIN_ROOM_APP).emit('counsellor:presence', payload);
}

function updatePresenceFromHttp(userId, status, name = null, branch = null, appOnly = false) {
  if (!VALID_STATUSES.includes(status)) return null;
  // Always update general presenceMap
  const entry = setPresence(userId, { status, name, branch });
  broadcastPresence({ userId: String(userId), ...entry });
  // Conditionally update app-only map
  if (appOnly) {
    const appEntry = setAppPresence(userId, { status, name, branch });
    broadcastAppPresence({ userId: String(userId), ...appEntry });
  }
  return entry;
}

// --- Socket.IO auth middleware: verify JWT on every connection ---
// --- Socket.IO auth middleware: verify JWT on every connection ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error('Unauthorized: missing token'));
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded; // attach verified payload
    next();
  } catch (err) {
    console.error('[AUTH] jwt.verify failed:', err.message);
    console.error('[AUTH] token prefix:', token?.substring(0, 40));
    console.error('[AUTH] JWT_SECRET length:', JWT_SECRET?.length, 'prefix:', JWT_SECRET?.substring(0, 8));
    return next(new Error('Unauthorized: invalid or expired token'));
  }
});

// --- Socket.IO connection & rooms ---
io.on('connection', (socket) => {
  // Derive identity from verified JWT payload, not raw handshake params
  const { id: userId, role, branch, name } = socket.user;
  const auth = socket.handshake.auth || socket.handshake.query || {};
  const clientType = (auth.clientType || auth.client_type || '').toLowerCase();
  const isApp = clientType === 'app';
  const normalizedRole = (role || '').toLowerCase().replace(/[_ ]/g, '');

  socket.clientType = clientType;
  socket.userId = userId;
  socket.normalizedRole = normalizedRole;

  // Track metadata for clean disconnect
  socketMeta.set(socket.id, { userId, isApp, normalizedRole });

  console.log('✅ Socket connected:', socket.id, { userId, role, branch, clientType: clientType || 'web' });

  if (userId) socket.join(String(userId));
  if (role) socket.join(role);
  if (branch) socket.join(`branch-${branch}`);

  // --- Presence ---
  if (userId) {
    if (normalizedRole === 'superadmin') {
      socket.join(ADMIN_ROOM);
      if (isApp) {
        socket.join(ADMIN_ROOM_APP);
        console.log('🔹 Admin joined app-only room:', ADMIN_ROOM_APP);
        const snapshot = Array.from(appPresenceMap.entries()).map(([id, data]) => ({ userId: id, ...data }));
        socket.emit('counsellor:presence:snapshot', snapshot);
      } else {
        console.log('🔹 Admin joined room:', ADMIN_ROOM);
        const snapshot = Array.from(presenceMap.entries()).map(([id, data]) => ({ userId: id, ...data }));
        socket.emit('counsellor:presence:snapshot', snapshot);
      }
    } else if (['counsellor', 'telecaller', 'user'].includes(normalizedRole)) {
      const initialStatus = VALID_STATUSES.includes(auth?.status) ? auth.status : 'active';
      const entry = setPresence(userId, { status: initialStatus, name, branch });
      broadcastPresence({ userId: String(userId), ...entry });
      if (isApp) {
        const appEntry = setAppPresence(userId, { status: initialStatus, name, branch });
        broadcastAppPresence({ userId: String(userId), ...appEntry });
      }

      socket.on('counsellor:status', (payload) => {
        const s = VALID_STATUSES.includes(payload?.status) ? payload.status : 'active';
        const e = setPresence(userId, { status: s, name, branch });
        broadcastPresence({ userId: String(userId), ...e });
        if (isApp) {
          const appEntry = setAppPresence(userId, { status: s, name, branch });
          broadcastAppPresence({ userId: String(userId), ...appEntry });
        }
      });
    }
  }

  socket.on('disconnect', (reason) => {
    const meta = socketMeta.get(socket.id);
    if (meta) {
      const { userId: uid, isApp: wasApp, normalizedRole: nRole } = meta;
      if (['counsellor', 'telecaller', 'user'].includes(nRole)) {
        // Only remove presence if no other socket for this userId is still connected
        const userSockets = io.sockets.adapter.rooms.get(String(uid));
        if (!userSockets || userSockets.size === 0) {
          removePresence(uid);
          if (wasApp) removeAppPresence(uid);
        }
      }
      socketMeta.delete(socket.id);
    }
    console.log('❌ Socket disconnected:', socket.id, reason);
  });
});

// --- Helper to broadcast notifications ---
const broadcastNotification = ({ notification, targetUserId, targetRole, targetBranch }) => {
  if (targetUserId) {
    io.to(String(targetUserId)).emit('notification', notification);
  } else if (targetRole) {
    io.to(targetRole).emit('notification', notification);
  } else if (targetBranch) {
    io.to(`branch-${targetBranch}`).emit('notification', notification);
  } else {
    io.emit('notification', notification);
  }
};

// --- Internal secret middleware for backend-to-socket-server calls ---
function requireInternalSecret(req, res, next) {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== EMIT_SECRET) {
    return res.status(403).json({ error: 'Forbidden: invalid internal secret' });
  }
  next();
}

// --- JWT middleware for HTTP routes (mobile/web clients) ---
function requireJWT(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = auth.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- Test route: dev only ---
if (process.env.NODE_ENV !== 'production') {
  app.get('/test-notification', (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    broadcastNotification({
      notification: {
        _id: Date.now(),
        type: 'test',
        title: 'Test Notification',
        message: '🎉 This is a test notification!',
        createdAt: new Date(),
      },
      targetUserId: userId,
    });
    res.json({ success: true, sentTo: userId });
  });
}

app.get('/', (req, res) => res.send('Socket server is running.'));

// --- POST /presence – mobile app reports active|idle|on_call ---
app.post('/presence', presenceLimiter, requireJWT, (req, res) => {
  const { id: userId, name: tokenName, branch: tokenBranch } = req.user;
  if (!userId) return res.status(401).json({ error: 'Invalid token: missing user id' });

  const status = VALID_STATUSES.includes(req.body?.status) ? req.body.status : 'active';
  const appOnly =
    (req.headers['x-client'] || '').toLowerCase() === 'app' ||
    (req.body?.clientType || '').toLowerCase() === 'app';

  updatePresenceFromHttp(
    userId,
    status,
    tokenName || req.body?.name,
    tokenBranch || req.body?.branch,
    appOnly
  );

  return res.json({ ok: true, status, appOnly: !!appOnly });
});

// --- GET /presence/app – app-only presence snapshot (super admin) ---
app.get('/presence/app', requireJWT, (req, res) => {
  const { id: userId } = req.user;
  if (!userId) return res.status(401).json({ error: 'Invalid token: missing user id' });

  const list = Array.from(appPresenceMap.entries()).map(([uid, data]) => ({ userId: uid, ...data }));
  return res.json({ ok: true, presence: list });
});

// --- POST /emit – internal only, called by Next.js backend ---
app.post('/emit', emitLimiter, requireInternalSecret, (req, res) => {
  const { notification, targetUserId, targetRole, targetBranch } = req.body;

  if (!notification || typeof notification !== 'object') {
    return res.status(400).json({ error: 'notification object is required' });
  }

  // Basic shape validation
  const required = ['type', 'title', 'createdAt'];
  const missing = required.filter((k) => !(k in notification));
  if (missing.length > 0) {
    return res.status(400).json({ error: `notification missing required fields: ${missing.join(', ')}` });
  }

  console.log('📩 Emit API called:', req.body);
  broadcastNotification({ notification, targetUserId, targetRole, targetBranch });

  return res.json({ ok: true });
});

const getIO = () => io;
module.exports = { getIO };

// --- Start server ---
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Socket server listening on ${PORT}`));
