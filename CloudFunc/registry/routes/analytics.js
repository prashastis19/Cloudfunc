const express = require("express");
const { pool } = require("../db");

const router = express.Router();

router.get("/summary", async (req, res) => {
  const owner = req.query.owner;

  try {
    const functionCountQuery = owner
      ? {
          text: "SELECT COUNT(*)::int AS count FROM functions WHERE owner_username = $1",
          values: [owner]
        }
      : {
          text: "SELECT COUNT(*)::int AS count FROM functions",
          values: []
        };

    const jobsQuery = owner
      ? {
          text: `
            SELECT
              COUNT(*)::int AS total_jobs,
              COUNT(*) FILTER (WHERE j.status = 'completed')::int AS completed_jobs,
              COUNT(*) FILTER (WHERE j.status = 'queued')::int AS queued_jobs,
              COUNT(*) FILTER (WHERE j.status = 'running')::int AS running_jobs,
              COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed_jobs
            FROM jobs j
            JOIN functions f ON f.name = j.function_name
            WHERE f.owner_username = $1
          `,
          values: [owner]
        }
      : {
          text: `
            SELECT
              COUNT(*)::int AS total_jobs,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
              COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_jobs,
              COUNT(*) FILTER (WHERE status = 'running')::int AS running_jobs,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_jobs
            FROM jobs
          `,
          values: []
        };

    const recentJobsQuery = owner
      ? {
          text: `
            SELECT
              j.job_id,
              j.function_name,
              j.status,
              j.result,
              j.error,
              j.submitted_at,
              j.completed_at,
              f.owner_username
            FROM jobs j
            JOIN functions f ON f.name = j.function_name
            WHERE f.owner_username = $1
            ORDER BY j.submitted_at DESC
            LIMIT 6
          `,
          values: [owner]
        }
      : {
          text: `
            SELECT
              j.job_id,
              j.function_name,
              j.status,
              j.result,
              j.error,
              j.submitted_at,
              j.completed_at,
              f.owner_username
            FROM jobs j
            LEFT JOIN functions f ON f.name = j.function_name
            ORDER BY j.submitted_at DESC
            LIMIT 6
          `,
          values: []
        };

    const [functionCount, jobsSummary, recentJobs] = await Promise.all([
      pool.query(functionCountQuery),
      pool.query(jobsQuery),
      pool.query(recentJobsQuery)
    ]);

    return res.json({
      stats: {
        functionsRegistered: functionCount.rows[0]?.count || 0,
        totalJobs: jobsSummary.rows[0]?.total_jobs || 0,
        completedJobs: jobsSummary.rows[0]?.completed_jobs || 0,
        queuedJobs: jobsSummary.rows[0]?.queued_jobs || 0,
        runningJobs: jobsSummary.rows[0]?.running_jobs || 0,
        failedJobs: jobsSummary.rows[0]?.failed_jobs || 0
      },
      recentJobs: recentJobs.rows
    });
  } catch (error) {
    console.error("Analytics summary error:", error);
    return res.status(500).json({
      error: "Failed to load summary"
    });
  }
});

module.exports = router;
