require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4001;
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:3000";


// --------------------------------
// WARM CONTAINER POOL
// --------------------------------

// functionName -> { containerId, port }
const containerPool = new Map();

// containerId -> lastUsedTime
const lastUsed = new Map();

// ✅ NEW: Port counter — each container gets a unique host port
// Container's runner always listens on port 4000 internally
// We map a unique host port -> container's 4000
let currentPort = 7000;

function getNextPort() {
  return currentPort++;
}


// --------------------------------
// ✅ NEW: WAIT FOR RUNNER TO BE READY
// --------------------------------

// After a new container starts, the runner (node runner.js) takes
// a moment to boot. We poll GET /health until we get a 200 response.
// This replaces the old setTimeout(1000) hack with a proper health check.

async function waitForRunner(port, retries = 15, delayMs = 500) {

  const url = `http://localhost:${port}/health`;

  for (let i = 0; i < retries; i++) {

    try {

      const response = await axios.get(url, { timeout: 1000 });

      if (response.status === 200) {
        console.log(`✅ Runner on port ${port} is ready`);
        return true;
      }

    } catch (err) {
      // Runner not ready yet, keep waiting
      console.log(`⏳ Waiting for runner on port ${port}... (attempt ${i + 1}/${retries})`);
    }

    // Wait before next attempt
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Runner on port ${port} did not become ready after ${retries} attempts`);
}


// --------------------------------
// START OR REUSE CONTAINER
// --------------------------------

function startContainer(functionName, imageName) {

  // If container already exists for this function, reuse it
  if (containerPool.has(functionName)) {

    const container = containerPool.get(functionName);

    console.log("♻️  Reusing warm container:", container.containerId, "on port", container.port);

    lastUsed.set(container.containerId, Date.now());

    // Return immediately — no need to wait for health check again
    return Promise.resolve(container);
  }

  // No container exists — start a new one
  return new Promise((resolve, reject) => {

    const port = getNextPort();
    const containerName = `cloudfunc-${functionName}-${Date.now()}`;

    // ✅ CHANGED: Now maps host port → container's internal port 4000
    // The runner inside the container listens on 4000
    // We expose it on a unique host port so container manager can call it via HTTP
    const cmd = `docker run -d -p ${port}:4000 --name ${containerName} ${imageName}`;

    exec(cmd, async (err, stdout, stderr) => {

      if (err) {
        console.error("Docker start failed:", stderr);
        return reject(new Error("Docker container failed to start"));
      }

      const containerId = stdout.trim();

      console.log(`🐳 Started container ${containerId} for function '${functionName}' on port ${port}`);

      // Store in pool
      containerPool.set(functionName, { containerId, port });
      lastUsed.set(containerId, Date.now());

      // ✅ NEW: Wait for the runner server inside the container to be ready
      // Poll /health endpoint until it responds with 200
      try {
        await waitForRunner(port);
        resolve({ containerId, port });
      } catch (healthErr) {
        // Runner didn't start — clean up
        containerPool.delete(functionName);
        lastUsed.delete(containerId);
        exec(`docker stop ${containerId}`);
        exec(`docker rm ${containerId}`);
        reject(healthErr);
      }

    });

  });
}


// --------------------------------
// CLEANUP IDLE CONTAINERS
// --------------------------------

setInterval(() => {

  const now = Date.now();

  for (const [fn, container] of containerPool.entries()) {

    const last = lastUsed.get(container.containerId);

    if (!last) continue;

    const idleTime = now - last;

    // Remove container idle for more than 5 minutes
    if (idleTime > 5 * 60 * 1000) {

      console.log(`🧹 Removing idle container: ${container.containerId} (function: ${fn})`);

      exec(`docker stop ${container.containerId}`);
      exec(`docker rm ${container.containerId}`);

      containerPool.delete(fn);
      lastUsed.delete(container.containerId);
    }

  }

}, 60000);


// --------------------------------
// EXECUTE FUNCTION
// --------------------------------

app.post("/execute", async (req, res) => {

  const { jobId, functionName, payload } = req.body;

  try {

    console.log(`▶️  Executing function: ${functionName} | job: ${jobId}`);

    // 1️⃣ Get image name from registry
    const response = await axios.get(
      `${REGISTRY_URL}/functions/${functionName}`
    );

    const imageName = response.data.image_name;

    // 2️⃣ Start or reuse container
    const { containerId, port } = await startContainer(functionName, imageName);

    // 3️⃣ ✅ CHANGED: Call runner via HTTP POST /run
    // Old way: docker exec -e PAYLOAD=... node index.js
    // New way: HTTP POST to the runner server running inside the container
    const runnerUrl = `http://localhost:${port}/run`;

    console.log(`📡 Calling runner at ${runnerUrl}`);

    const result = await axios.post(runnerUrl, payload || {}, {
      timeout: 30000  // 30 second timeout for function execution
    });

    // Update last used time
    lastUsed.set(containerId, Date.now());

    console.log(`✅ Function ${functionName} completed | result:`, result.data.result);

    // 4️⃣ Return result to worker
    res.json({
      success: result.data.success,
      result: result.data.result,
      error: result.data.error,
      executionTime: result.data.executionTime
    });

  } catch (error) {

    console.error("Execution failed:", error.message);

    // If it was an axios error from calling the runner
    if (error.response) {
      return res.status(500).json({
        success: false,
        error: error.response.data?.error || "Runner returned an error"
      });
    }

    res.status(500).json({
      success: false,
      error: "Function execution failed: " + error.message
    });

  }

});


// --------------------------------
// START SERVER
// --------------------------------

app.listen(PORT, () => {
  console.log(`🚀 Container Manager running on port ${PORT}`);
});