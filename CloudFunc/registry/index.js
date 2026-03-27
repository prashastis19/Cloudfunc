const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const functionsRouter = require("./routes/functions");
const jobsRouter = require("./routes/jobs");
const usersRouter = require("./routes/users");
const analyticsRouter = require("./routes/analytics");
const { ensureSchema } = require("./db");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

app.get("/health", async (_req, res) => {
  res.json({ ok: true, service: "registry" });
});

app.use("/users", usersRouter);
app.use("/functions", functionsRouter);
app.use("/jobs", jobsRouter);
app.use("/analytics", analyticsRouter);

const PORT = Number(process.env.REGISTRY_PORT || 3000);

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Registry running on ${PORT}`));
  })
  .catch((error) => {
    console.error("Failed to initialize registry schema:", error);
    process.exit(1);
  });
