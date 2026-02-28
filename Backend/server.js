const express = require("express");
const cors = require("cors");

const inventoryRoutes = require("./routes/inventory");
const financeRoutes = require("./routes/finance");

const app = express();

// Parse JSON
app.use(express.json({ limit: "2mb" }));

// CORS allowlist
const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://sea-bite-express.netlify.app"
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if (/^https:\/\/.*\.netlify\.app$/.test(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.options("*", cors());

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Routes
app.use("/api/inventory", inventoryRoutes);
app.use("/api/finance", financeRoutes);

// Error handler (prevents silent crashes)
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// IMPORTANT: Render provides PORT
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running on port", PORT));