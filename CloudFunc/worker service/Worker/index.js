const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const amqp = require("amqplib");
const axios = require("axios");

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:3000";
const CONTAINER_URL = process.env.CONTAINER_URL || "http://localhost:4001";

const QUEUE_NAME = "executions";
const WORKER_COUNT = 3;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));


// --------------------------------
// PROCESS A SINGLE JOB
// --------------------------------

async function processJob(job, attempt) {

  const { jobId, functionName, payload } = job;

  console.log(`▶️  Processing job ${jobId} for function ${functionName}`);

  // ✅ FIX: Only update to "running" on the first attempt
  // On retries the job is already in "running" state in the DB
  // Trying to patch it to "running" again causes a 400 (invalid transition)
  if (attempt === 1) {
    await axios.patch(`${REGISTRY_URL}/jobs/${jobId}`, {
      status: "running",
    });
  }

  // Call container manager — it handles docker container + HTTP runner internally
  const response = await axios.post(`${CONTAINER_URL}/execute`, {
    jobId,
    functionName,
    payload,
  });

  console.log(`📦 Execution result for job ${jobId}:`, response.data);

  // Mark job as completed and store result
  await axios.patch(`${REGISTRY_URL}/jobs/${jobId}`, {
    status: "completed",
    result: JSON.stringify(response.data),
  });
}


// --------------------------------
// RETRY WITH EXPONENTIAL BACKOFF
// --------------------------------

async function executeWithRetry(job) {

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {

    try {

      // ✅ FIX: Pass attempt number to processJob
      await processJob(job, attempt);
      console.log(`✅ Job ${job.jobId} completed successfully`);
      return;

    } catch (err) {

      console.error(
        `❌ Job ${job.jobId} failed (attempt ${attempt}/${MAX_RETRIES}):`,
        err.message
      );

      if (attempt === MAX_RETRIES) {
        // All retries exhausted — mark as failed
        try {
          await axios.patch(`${REGISTRY_URL}/jobs/${job.jobId}`, {
            status: "failed",
            error: err.message,
          });
        } catch (patchErr) {
          console.error("Failed to update job status to failed:", patchErr.message);
        }
        return;
      }

      // Exponential backoff: attempt 1 → 1s, attempt 2 → 2s, attempt 3 → 4s
      const waitTime = Math.pow(2, attempt - 1) * 1000;
      console.log(`⏳ Retrying job ${job.jobId} in ${waitTime}ms...`);
      await sleep(waitTime);
    }
  }
}


// --------------------------------
// WORKER CONSUMER
// --------------------------------

async function startWorker(workerId, channel) {

  await channel.consume(
    QUEUE_NAME,
    async (msg) => {

      if (!msg) return;

      const job = JSON.parse(msg.content.toString());

      console.log(`👷 Worker ${workerId} picked up job ${job.jobId}`);

      try {
        await executeWithRetry(job);
        channel.ack(msg);
      } catch (err) {
        console.error(`Worker ${workerId} unexpected error:`, err.message);
        channel.ack(msg);
      }
    },
    { noAck: false }
  );
}


// --------------------------------
// RECOVER QUEUED JOBS ON STARTUP
// --------------------------------

async function recoverQueuedJobs(channel) {

  console.log("🔍 Checking DB for unfinished queued jobs...");

  try {

    const response = await axios.get(`${REGISTRY_URL}/jobs`);

    const jobs = response.data.filter(j => j.status === "queued");

    if (jobs.length === 0) {
      console.log("✅ No queued jobs to recover");
      return;
    }

    console.log(`♻️  Recovering ${jobs.length} queued job(s)...`);

    for (const job of jobs) {

      console.log("Re-queueing job:", job.job_id);

      channel.sendToQueue(
        QUEUE_NAME,
        Buffer.from(JSON.stringify({
          jobId: job.job_id,
          functionName: job.function_name,
          payload: JSON.parse(job.payload)
        }))
      );
    }

  } catch (err) {

    console.log("Recovery error:");

    if (err.response) {
      console.log("Status:", err.response.status);
      console.log("Data:", err.response.data);
    } else {
      console.log(err.message);
    }
  }
}


// --------------------------------
// START WORKER SYSTEM
// --------------------------------

async function start() {

  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });

  // Each worker handles only 1 job at a time
  channel.prefetch(1);

  console.log("✅ Worker connected to RabbitMQ");

  // Recover any jobs that were queued before worker started
  await recoverQueuedJobs(channel);

  // Start multiple parallel workers
  for (let i = 1; i <= WORKER_COUNT; i++) {
    startWorker(i, channel);
    console.log(`👷 Worker ${i} started`);
  }
}

start().catch(console.error);
