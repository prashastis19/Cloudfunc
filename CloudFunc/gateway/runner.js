/**
 * runner.js — Function Runtime API Server
 *
 * This file is copied into every function's Docker image by the gateway.
 * When a container starts, it runs this file (node runner.js).
 * It opens an HTTP server on port 4000 and waits for execution requests.
 *
 * The container manager calls POST /run with the payload.
 * Runner loads handler.js, calls the exported function, and returns the result.
 *
 * This is similar to how AWS Lambda uses a Runtime API inside each execution environment.
 */

const express = require("express");
const handler = require("./handler");

const app = express();
app.use(express.json());

const PORT = 4000;


// --------------------------------
// HEALTH CHECK
// --------------------------------

// Container manager polls this endpoint to know when the runner is ready
// It keeps checking until it gets a 200 response, then sends the real request

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});


// --------------------------------
// FUNCTION EXECUTION
// --------------------------------

app.post("/run", async (req, res) => {

  const startTime = Date.now();

  try {

    // req.body is the payload sent by container manager
    // It is passed directly to the user's handler function
    const input = req.body;

    console.log("Executing with input:", JSON.stringify(input));

    // Call the user's exported handler function
    // handler.js must export:  module.exports = async (input) => { ... }
    const result = await handler(input);

    const execTime = Date.now() - startTime;

    console.log("Execution result:", result, "| Time:", execTime + "ms");

    res.json({
      success: true,
      result: result,
      error: null,
      executionTime: execTime + "ms"
    });

  } catch (err) {

    const execTime = Date.now() - startTime;

    console.error("Execution error:", err.message);

    res.json({
      success: false,
      result: null,
      error: err.message,
      executionTime: execTime + "ms"
    });

  }

});


// --------------------------------
// START RUNNER
// --------------------------------

app.listen(PORT, () => {
  console.log(`🟢 Runner started on port ${PORT}`);
});