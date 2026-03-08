const amqp = require("amqplib");
const axios = require("axios");
require("dotenv").config();

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost:5672";
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:3000";
const CONTAINER_URL = process.env.CONTAINER_URL || "http://localhost:4001";

const QUEUE_NAME = "executions";
const WORKER_COUNT = 3;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function processJob(job) {
  const { jobId, functionName, payload } = job;

  console.log(`Processing job ${jobId} for function ${functionName}`);

  await axios.patch(`${REGISTRY_URL}/jobs/${jobId}`, {
    status: "running",
  });

  const response = await axios.post(`${CONTAINER_URL}/execute`, {
    jobId,
    functionName,
    payload,
  });

  console.log("Execution result:", response.data);

  await axios.patch(`${REGISTRY_URL}/jobs/${jobId}`, {
    status: "completed",
    result: JSON.stringify(response.data),
  });
}

async function executeWithRetry(job) {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await processJob(job);
      console.log(`Job ${job.jobId} completed`);
      return;
    } catch (err) {

      console.error(
        `Job ${job.jobId} failed (attempt ${attempt}):`,
        err.message
      );

      if (attempt === MAX_RETRIES) {
        await axios.patch(`${REGISTRY_URL}/jobs/${job.jobId}`, {
          status: "failed",
          error: err.message,
        });
        return;
      }

      await sleep(Math.pow(2, attempt - 1) * 1000);
    }
  }
}

async function startWorker(workerId, channel) {

  await channel.consume(
    QUEUE_NAME,
    async (msg) => {

      if (!msg) return;

      const job = JSON.parse(msg.content.toString());

      console.log(`Worker ${workerId} processing job ${job.jobId}`);

      try {
        await executeWithRetry(job);
        channel.ack(msg);
      } catch (err) {
        console.error("Unexpected error:", err.message);
        channel.ack(msg);
      }
    },
    { noAck: false }
  );
}

async function recoverQueuedJobs(channel) {

  console.log("Checking DB for queued jobs...");

  try {

    const response = await axios.get(`${REGISTRY_URL}/jobs`);

    // console.log("Jobs from registry:", response.data);

    const jobs = response.data.filter(j => j.status === "queued");

    for (const job of jobs) {

      console.log("Re-queueing job:", job.job_id);

      channel.sendToQueue(
        QUEUE_NAME,
        Buffer.from(JSON.stringify({
          jobId: job.job_id,
          functionName: job.function_name,
          payload: JSON.parse(job.payload)        }))
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

async function start() {

  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });

  channel.prefetch(1);

  console.log("Worker connected to RabbitMQ");

  // Recover jobs from DB
  await recoverQueuedJobs(channel);

  for (let i = 1; i <= WORKER_COUNT; i++) {
    startWorker(i, channel);
  }
}

start().catch(console.error);