require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/database");
const authRoutes  = require("./routes/AuthRoutes");
const videoRoutes = require("./routes/VideoRoutes");
const userRoutes  = require("./routes/UserRoutes");

const app = express();

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

// ── CORS — allow all dev origins (mobile LAN IP + localhost) ─────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile apps, curl) and listed origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
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

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
