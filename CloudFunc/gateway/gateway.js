require("dotenv").config();
const express = require("express");
const axios = require("axios");
const amqp = require("amqplib");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:3000";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost";

let channel;

// --------------------------------
// START SERVER + RABBITMQ
// --------------------------------

async function startServer() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    await channel.assertQueue("executions", { durable: true });

    console.log("✅ Connected to RabbitMQ");

    app.listen(PORT, () => {
      console.log(`🚀 Gateway running on port ${PORT}`);
    });

  } catch (err) {
    console.error("RabbitMQ connection error:", err.message);
    process.exit(1);
  }
}


// --------------------------------
// REGISTER FUNCTION
// --------------------------------

app.post("/register", async (req, res) => {

  const { name, runtime, code } = req.body;

  if (!name || !runtime || !code) {
    return res.status(400).json({
      error: "name, runtime and code are required"
    });
  }

  const dir = `tmp/function-${name}-${Date.now()}`;
  const imageName = `cloudfunc-${name}:latest`;

  try {

    // Create temp folder
    fs.mkdirSync(dir, { recursive: true });

    // ✅ CHANGED: User's function code goes into handler.js (not index.js)
    // User must export a function like:  module.exports = async (input) => { ... }
    fs.writeFileSync(`${dir}/handler.js`, code);

    // ✅ NEW: Copy runner.js from gateway's own folder into the Docker build folder
    // runner.js is the runtime API server that will run inside every container
    const runnerSource = path.join(__dirname, "runner.js");
    fs.copyFileSync(runnerSource, `${dir}/runner.js`);

    // ✅ NEW: Write package.json so npm install fetches express inside the container
    fs.writeFileSync(
      `${dir}/package.json`,
      JSON.stringify({
        name: `function-${name}`,
        version: "1.0.0",
        main: "runner.js",
        dependencies: {
          express: "^4.18.2"
        }
      }, null, 2)
    );

    // ✅ CHANGED: Dockerfile now starts runner.js
    // runner.js opens port 4000 and waits for POST /run requests
    // No more infinite sleep loop - the runner keeps the container alive
    const dockerfile = `
FROM node:18-alpine

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 4000

CMD ["node", "runner.js"]
`;

    fs.writeFileSync(`${dir}/Dockerfile`, dockerfile);

    console.log("🔨 Building Docker image...");

    exec(`docker build -t ${imageName} ${dir}`, async (err, stdout, stderr) => {

      try {

        if (err) {
          console.error(stderr);
          return res.status(500).json({
            error: "Docker build failed"
          });
        }

        console.log(stdout);
        console.log("✅ Docker image built:", imageName);

        // Store metadata in registry
        await axios.post(`${REGISTRY_URL}/functions`, {
          name,
          imageName,
          runtime
        });

        res.status(201).json({
          message: "Function registered successfully",
          image: imageName
        });

      } catch (error) {

        console.error("Registry error:", error.message);

        res.status(500).json({
          error: "Function registration failed"
        });

      } finally {

        // Cleanup tmp folder
        fs.rmSync(dir, { recursive: true, force: true });
        console.log("🧹 Temp folder removed:", dir);

      }

    });

  } catch (error) {

    console.error("Register error:", error.message);

    fs.rmSync(dir, { recursive: true, force: true });

    res.status(500).json({
      error: "Function registration failed"
    });
  }

});


// --------------------------------
// INVOKE FUNCTION
// --------------------------------

app.post("/invoke", async (req, res) => {

  const { functionName, payload } = req.body;

  if (!functionName || payload === undefined) {
    return res.status(400).json({
      error: "functionName and payload are required"
    });
  }

  try {

    const jobId = uuidv4();

    // Verify function exists
    await axios.get(`${REGISTRY_URL}/functions/${functionName}`);

    // Create job
    await axios.post(`${REGISTRY_URL}/jobs`, {
      jobId,
      functionName,
      payload
    });

    // Push job to RabbitMQ
    channel.sendToQueue(
      "executions",
      Buffer.from(
        JSON.stringify({
          jobId,
          functionName,
          payload
        })
      ),
      { persistent: true }
    );

    res.status(200).json({ jobId });

  } catch (error) {

    console.error("Gateway error:", error.message);

    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    res.status(500).json({
      error: "Internal Gateway Error"
    });
  }

});


// --------------------------------
// CHECK JOB STATUS
// --------------------------------

app.get("/jobs/:jobId", async (req, res) => {

  try {

    const response = await axios.get(
      `${REGISTRY_URL}/jobs/${req.params.jobId}`
    );

    res.json(response.data);

  } catch (error) {

    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    res.status(500).json({
      error: "Gateway error retrieving job"
    });
  }

});


startServer();