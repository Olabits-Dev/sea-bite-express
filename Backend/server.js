require("dotenv").config();
const express = require("express");
const cors = require("cors");

const inventoryRoutes = require("./routes/inventory");
const financeRoutes = require("./routes/finance");

const app = express();
app.use(express.json());

const allowedOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin }));

app.get("/", (_req, res) => res.json({ ok: true, service: "SeaBite Tracker Backend" }));

app.use("/api/inventory", inventoryRoutes);
app.use("/api/finance", financeRoutes);

const port = Number(process.env.PORT || 5000);
app.listen(port, () => console.log(`Backend running on port ${port}`));