// dotenv MUST be the first line so every later `require(...)` sees the
// resolved env. emailService relies on this — its transporter is lazy-
// initialised on first use, but the config banner below confirms the env
// reached the process at boot time.
require("dotenv").config();

const express = require("express");
const http    = require("http");
const cors = require("cors");
const connectDB = require("./config/database");
const authRoutes  = require("./routes/AuthRoutes");
const videoRoutes = require("./routes/VideoRoutes");
const userRoutes  = require("./routes/UserRoutes");
const chatRoutes  = require("./routes/ChatRoutes");
const aiRoutes       = require("./routes/AIRoutes");
const activityRoutes = require("./routes/ActivityRoutes");
const { initSocket } = require("./socket");

const app    = express();
const server = http.createServer(app);

// Connect to MongoDB
connectDB();

// Middleware
// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',  'nosniff');
  res.setHeader('X-Frame-Options',         'DENY');
  res.setHeader('X-XSS-Protection',        '1; mode=block');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  next();
});

// ── CORS — flexible for dev, strict for prod ────────────────────────────────
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(
  cors({
    origin: (origin, cb) => {
      // Mobile apps send no origin — always allow
      if (!origin) return cb(null, true);

      if (IS_PROD) {
        // Production: only allow explicit frontend URL
        const allowed = [process.env.FRONTEND_URL].filter(Boolean);
        if (allowed.includes(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin ${origin} not allowed`));
      }

      // Development: allow any localhost / LAN IP (192.168.x.x, 10.x.x.x, 172.x.x.x)
      if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }

      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// ── Basic in-memory rate limiter (no extra package needed) ────────────────────
const rateLimitMap = new Map();
const rateLimit = (maxReqs, windowMs) => (req, res, next) => {
  const key  = req.ip || 'unknown';
  const now  = Date.now();
  const data = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - data.start > windowMs) { data.count = 0; data.start = now; }
  data.count += 1;
  rateLimitMap.set(key, data);
  if (data.count > maxReqs) {
    return res.status(429).json({ success: false, message: 'Too many requests — please slow down.' });
  }
  next();
};
// Clear stale entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  rateLimitMap.forEach((v, k) => { if (v.start < cutoff) rateLimitMap.delete(k); });
}, 10 * 60 * 1000);

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - start;
    const code = res.statusCode;
    const col  = code >= 500 ? '\x1b[31m' : code >= 400 ? '\x1b[33m' : '\x1b[32m';
    console.log(`${col}${req.method} ${req.path} ${code} — ${ms}ms\x1b[0m`);
  });
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes — auth endpoints are stricter (prevent brute-force)
app.use("/api/auth",   rateLimit(30, 15 * 60 * 1000), authRoutes);
app.use("/api/videos", rateLimit(200, 60 * 1000),     videoRoutes);
app.use("/api/users",  rateLimit(100, 60 * 1000),     userRoutes);
app.use("/api/chats",  rateLimit(200, 60 * 1000),     chatRoutes);
app.use("/api/ai",       rateLimit(60,  60 * 1000), aiRoutes);
app.use("/api/activity", rateLimit(200, 60 * 1000), activityRoutes);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Server is running",
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: err.message || "Server Error",
  });
});

// ── Boot-time SMTP config visibility ────────────────────────────────────────
// Doesn't open a connection — only prints whether EMAIL_USER / EMAIL_PASS
// reached this process. Real verify happens on first email send (lazy).
try { require('./services/emailService').logConfigStatus(); } catch (_) { /* optional */ }

// ── Initialize Socket.IO ─────────────────────────────────────────────────────
initSocket(server);

const PORT = process.env.PORT || 5000;
// Explicit 0.0.0.0 binds to every network interface so phones/devices on
// the same Wi-Fi can reach the server via the host machine's LAN IP, not
// just localhost. (Node's default is also 0.0.0.0 but being explicit
// removes ambiguity when diagnosing "connection refused" reports.)
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on ${HOST}:${PORT}`);
  // Print every IPv4 address the server can be reached on — handy when
  // pointing a phone or emulator at the dev backend.
  try {
    const nets = require('os').networkInterfaces();
    Object.values(nets).flat().forEach((n) => {
      if (n && n.family === 'IPv4' && !n.internal) {
        console.log(`   • http://${n.address}:${PORT}`);
      }
    });
    console.log(`   • http://localhost:${PORT}  (same machine only)`);
  } catch (_) { /* network introspection is optional */ }
});

module.exports = { app, server };
