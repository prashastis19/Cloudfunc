const express = require("express");
const { pool } = require("../db");

const router = express.Router();

/*
  Register a function (metadata only)
  Gateway builds the Docker image first,
  then calls this endpoint to store metadata.
*/
router.post("/", async (req, res) => {
  const { name, imageName, runtime, ownerUsername } = req.body;

  if (!name || !imageName) {
    return res.status(400).json({
      error: "name and imageName are required"
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO functions (name, image_name, runtime, owner_username)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [name, imageName, runtime || "nodejs", ownerUsername || "anonymous"]
    );

    return res.status(201).json({
      message: "Function registered",
      function: result.rows[0]
    });

  } catch (err) {

    // duplicate function
    if (err.code === "23505") {
      return res.status(409).json({
        error: "Function already exists"
      });
    }

    console.error("Function registration error:", err);

    return res.status(500).json({
      error: "Internal server error"
    });
  }
});

router.get("/", async (req, res) => {
  const search = String(req.query.search || "").trim().toLowerCase();
  const owner = req.query.owner;

  try {
    const values = [];
    const filters = [];

    if (owner) {
      values.push(owner);
      filters.push(`owner_username = $${values.length}`);
    }

    if (search) {
      values.push(`%${search}%`);
      filters.push(`(
        LOWER(name) LIKE $${values.length}
        OR LOWER(owner_username) LIKE $${values.length}
        OR LOWER(image_name) LIKE $${values.length}
      )`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT *
      FROM functions
      ${whereClause}
      ORDER BY created_at DESC, name ASC
      `,
      values
    );

    return res.json(result.rows);
  } catch (error) {
    console.error("Function list error:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});


/*
  Get function metadata
  Worker uses this to know which Docker image to run
*/
router.get("/:name", async (req, res) => {

  try {
    const result = await pool.query(
      `SELECT * FROM functions WHERE name = $1`,
      [req.params.name]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Function not found"
      });
    }

    return res.json(result.rows[0]);

  } catch (err) {
    console.error("Function lookup error:", err);

    return res.status(500).json({
      error: "Internal server error"
    });
  }

});

router.delete("/:name", async (req, res) => {
  try {
    const deleted = await pool.query(
      `
      DELETE FROM functions
      WHERE name = $1
      RETURNING *
      `,
      [req.params.name]
    );

    if (deleted.rows.length === 0) {
      return res.status(404).json({
        error: "Function not found"
      });
    }

    return res.json({
      message: "Function deleted",
      function: deleted.rows[0]
    });
  } catch (error) {
    console.error("Function delete error:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});

module.exports = router;
