const cors = require("cors");

const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",

  // ✅ Your Netlify site (this fixes your error)
  "https://sea-bite-express.netlify.app",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (Postman, curl, some mobile contexts)
      if (!origin) return cb(null, true);

      // ✅ Allow exact matches
      if (allowedOrigins.has(origin)) return cb(null, true);

      // Optional: allow ANY netlify preview deploys like https://deploy-preview-12--xxx.netlify.app
      if (/^https:\/\/.*\.netlify\.app$/.test(origin)) return cb(null, true);

      return cb(new Error("CORS blocked: " + origin), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ IMPORTANT: respond to preflight
app.options("*", cors());