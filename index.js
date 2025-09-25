require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST'],
}));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
  path: '/socket.io', // default
});

// Connection handling + rooms (per-user)
io.on('connection', (socket) => {
  const { userId, role, branch } = socket.handshake.auth || socket.handshake.query || {};

  console.log('✅ Socket connected:', socket.id, { userId, role, branch });

  if (userId) socket.join(userId.toString());        // private room
  if (role) socket.join(role);                       // role room
  if (branch) socket.join(`branch-${branch}`);       // branch room

  socket.on('disconnect', (reason) => {
    console.log('❌ Socket disconnected:', socket.id, reason);
  });
});



app.get("/test-notification", (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  io.to(userId).emit("notification", {
    _id: Date.now(),
    type: "test",
    title: "Test Notification",
    message: "🎉 This is a test notification!",
    createdAt: new Date(),
  });

  res.json({ success: true, sentTo: userId });
});

// Simple authenticated HTTP endpoint to emit notifications
app.post('/emit', (req, res) => {
  const { notification, targetUserId, targetRole, targetBranch } = req.body;

  console.log("📩 Emit API called:", req.body);

  if (targetUserId) {
    io.to(targetUserId.toString()).emit('notification', notification);
  } else if (targetRole) {
    io.to(targetRole).emit('notification', notification);
  } else if (targetBranch) {
    io.to(`branch-${targetBranch}`).emit('notification', notification);
  } else {
    io.emit('notification', notification);
  }

  return res.json({ ok: true });
});



const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Socket server listening on ${PORT}`));
