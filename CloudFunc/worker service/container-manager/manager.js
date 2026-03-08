require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4001;
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:3000";


// -----------------------------
// WARM CONTAINER POOL
// -----------------------------

// functionName -> containerId
const containerPool = new Map();

// containerId -> lastUsedTime
const lastUsed = new Map();


// -----------------------------
// START OR REUSE CONTAINER
// -----------------------------

function startContainer(functionName, imageName) {

  if (containerPool.has(functionName)) {

    const containerId = containerPool.get(functionName);

    console.log("Reusing warm container:", containerId);

    lastUsed.set(containerId, Date.now());

    return Promise.resolve(containerId);
  }

  return new Promise((resolve, reject) => {

    const containerName = `cloudfunc-${functionName}-${Date.now()}`;

    const cmd = `docker run -dit --name ${containerName} ${imageName} sh`;

    exec(cmd, (err, stdout, stderr) => {

      if (err) {
        console.error("Docker start failed:", stderr);
        return reject(err);
      }

      const containerId = stdout.trim();

      console.log("Started new container:", containerId);

      containerPool.set(functionName, containerId);
      lastUsed.set(containerId, Date.now());

      resolve(containerId);
    });

  });
}


// -----------------------------
// CLEANUP IDLE CONTAINERS
// -----------------------------

setInterval(() => {

  const now = Date.now();

  for (const [fn, containerId] of containerPool.entries()) {

    const last = lastUsed.get(containerId);

    if (!last) continue;

    const idleTime = now - last;

    // remove container idle for >5 minutes
    if (idleTime > 5 * 60 * 1000) {

      console.log("Removing idle container:", containerId);

      exec(`docker stop ${containerId}`);
      exec(`docker rm ${containerId}`);

      containerPool.delete(fn);
      lastUsed.delete(containerId);
    }

  }

}, 60000);


// -----------------------------
// EXECUTE FUNCTION
// -----------------------------

app.post("/execute", async (req, res) => {

  const { jobId, functionName, payload } = req.body;

  try {

    console.log(`Executing function: ${functionName}`);

    // 1️⃣ get image name from registry
    const response = await axios.get(
      `${REGISTRY_URL}/functions/${functionName}`
    );

    const imageName = response.data.image_name;

    // 2️⃣ start or reuse container
    const containerId = await startContainer(functionName, imageName);

    const payloadString = JSON.stringify(payload || {});

    // 3️⃣ execute function inside container
    const command =
      `docker exec -e PAYLOAD='${payloadString}' ${containerId} node index.js`;

    exec(command, (err, stdout, stderr) => {

      if (err) {

        console.error("Execution error:", stderr);

        return res.status(500).json({
          success: false,
          error: stderr
        });
      }

      console.log("Function output:", stdout);

      lastUsed.set(containerId, Date.now());

      res.json({
        success: true,
        result: stdout.trim()
      });

    });

  } catch (error) {

    console.error("Execution failed:", error.message);

    res.status(500).json({
      success: false,
      error: "Function execution failed"
    });

  }

});


// -----------------------------
// START SERVER
// -----------------------------

app.listen(PORT, () => {
  console.log(`Container Manager running on port ${PORT}`);
});