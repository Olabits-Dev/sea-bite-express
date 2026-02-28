const express = require("express");
const cors = require("cors");

const inventoryRoutes = require("./routes/inventory");
const financeRoutes = require("./routes/finance");

const app = express();

// -----------------------
// Middleware
// -----------------------
app.use(express.json({ limit: "2mb" }));

// ✅ Permanent CORS Fix (Netlify + local + custom domain)
const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",

  // ✅ Add your Netlify site URL here (with https://)
  "https://sea-bite-express.netlify.app/",

  // ✅ If you have a custom domain
  // "https://yourdomain.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (like curl, Postman)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) return callback(null, true);

      return callback(new Error("CORS blocked: " + origin), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false
  })
);

// ✅ Handle preflight for all routes
app.options("*", cors());

// -----------------------
// Health check (for debugging Render)
// -----------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// -----------------------
// Routes
// -----------------------
app.use("/api/inventory", inventoryRoutes);
app.use("/api/finance", financeRoutes);

// -----------------------
// Error handler (more readable errors)
// -----------------------
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running on port", PORT));