const { Pool } = require("pg");

const dbConfig = {
  host: process.env.POSTGRES_HOST || "127.0.0.1",
  user: process.env.POSTGRES_USER || "postgres",
  password: process.env.POSTGRES_PASSWORD || "postgres",
  database: process.env.POSTGRES_DB || "cloudfunc",
  port: Number(process.env.POSTGRES_PORT || 5432)
};

const pool = new Pool(dbConfig);

function logConnectionTarget() {
  console.log(
    `Registry DB target -> host=${dbConfig.host} port=${dbConfig.port} db=${dbConfig.database} user=${dbConfig.user}`
  );
}

async function ensureSchema() {
  logConnectionTarget();

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS functions (
        name VARCHAR(255) PRIMARY KEY,
        image_name VARCHAR(255) NOT NULL,
        runtime VARCHAR(50),
        owner_username VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id VARCHAR(36) PRIMARY KEY,
        function_name VARCHAR(255),
        payload TEXT,
        status VARCHAR(20),
        result TEXT,
        error TEXT,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        attempts INT DEFAULT 0
      );
    `);

    await pool.query(`
      ALTER TABLE functions
      ADD COLUMN IF NOT EXISTS owner_username VARCHAR(255);
    `);

    await pool.query(`
      ALTER TABLE functions
      ADD COLUMN IF NOT EXISTS runtime VARCHAR(50);
    `);

    await pool.query(`
      ALTER TABLE functions
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    await pool.query(`
      ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS payload TEXT,
      ADD COLUMN IF NOT EXISTS status VARCHAR(20),
      ADD COLUMN IF NOT EXISTS result TEXT,
      ADD COLUMN IF NOT EXISTS error TEXT,
      ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
    `);
  } catch (error) {
    if (error.code === "28P01") {
      error.message = `${error.message}\nCheck the running Postgres container credentials and make sure registry/.env matches them.`;
    }

    throw error;
  }
}

module.exports = {
  pool,
  ensureSchema
};
