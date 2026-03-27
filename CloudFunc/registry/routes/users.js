const crypto = require("crypto");
const express = require("express");
const { pool } = require("../db");

const router = express.Router();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const passwordHash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");

  return { salt, passwordHash };
}

function normalizeIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.username,
    displayName: user.display_name || user.username,
    createdAt: user.created_at
  };
}

router.post("/register", async (req, res) => {
  const { username, email, password, displayName } = req.body;
  const identity = normalizeIdentity(email || username);

  if (!identity || !password) {
    return res.status(400).json({
      error: "email and password are required"
    });
  }

  if (!isValidEmail(identity)) {
    return res.status(400).json({
      error: "enter a valid email address"
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error: "password must be at least 6 characters"
    });
  }

  const { salt, passwordHash } = hashPassword(password);

  try {
    const result = await pool.query(
      `
      INSERT INTO users (username, display_name, password_hash, password_salt)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username, display_name, created_at
      `,
      [
        identity,
        displayName?.trim() || identity.split("@")[0],
        passwordHash,
        salt
      ]
    );

    return res.status(201).json({
      message: "User created",
      user: sanitizeUser(result.rows[0])
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error: "email already exists"
      });
    }

    console.error("User registration error:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});

router.post("/login", async (req, res) => {
  const { username, email, password } = req.body;
  const identity = normalizeIdentity(email || username);

  if (!identity || !password) {
    return res.status(400).json({
      error: "email and password are required"
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, username, display_name, password_hash, password_salt, created_at
      FROM users
      WHERE username = $1
      `,
      [identity]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "invalid credentials"
      });
    }

    const user = result.rows[0];
    const { passwordHash } = hashPassword(password, user.password_salt);

    if (passwordHash !== user.password_hash) {
      return res.status(401).json({
        error: "invalid credentials"
      });
    }

    return res.json({
      message: "Login successful",
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error("User login error:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});

module.exports = router;
