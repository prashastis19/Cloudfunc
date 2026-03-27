const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const amqp = require("amqplib");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const { exec } = require("child_process");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 8080);
const REGISTRY_URL = process.env.REGISTRY_URL || "http://localhost:3000";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost";
const JWT_SECRET = process.env.JWT_SECRET || "cloudfunc-dev-secret";
const TOKEN_TTL_HOURS = Number(process.env.JWT_TTL_HOURS || 12);
const publicDir = path.join(__dirname, "public");

let channel;

const templateLibrary = [
  {
    id: "sum",
    title: "Quick Math",
    runtime: "nodejs18",
    description: "Tiny starter for arithmetic and payload validation.",
    code: `module.exports = async (input) => {
  const a = Number(input?.a || 0);
  const b = Number(input?.b || 0);

  return {
    total: a + b,
    operands: [a, b]
  };
};`
  },
  {
    id: "json-transform",
    title: "JSON Transformer",
    runtime: "nodejs18",
    description: "Useful for mapping payloads into cleaner API responses.",
    code: `module.exports = async (input) => {
  return {
    receivedAt: new Date().toISOString(),
    keys: Object.keys(input || {}),
    payload: input || {}
  };
};`
  },
  {
    id: "health-report",
    title: "Health Report",
    runtime: "nodejs18",
    description: "Starter that returns service-style diagnostics.",
    code: `module.exports = async (input) => {
  return {
    ok: true,
    region: input?.region || "ap-south",
    latencyBudgetMs: input?.latencyBudgetMs || 250,
    traceId: input?.traceId || "demo-trace"
  };
};`
  }
];

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function signToken(user) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
      iat: now,
      exp: now + TOKEN_TTL_HOURS * 60 * 60
    })
  );
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  const [header, payload, signature] = token.split(".");

  if (!header || !payload || !signature) {
    throw new Error("Malformed token");
  }

  const expectedSignature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  if (signature !== expectedSignature) {
    throw new Error("Invalid signature");
  }

  const data = JSON.parse(base64UrlDecode(payload));

  if (data.exp && data.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return data;
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!token) {
    return res.status(401).json({
      error: "Authentication required"
    });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch (error) {
    return res.status(401).json({
      error: error.message
    });
  }
}

function formatUserResponse(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || user.username,
    displayName: user.displayName || user.username,
    createdAt: user.createdAt
  };
}

function parsePossiblyJson(value) {
  if (!value || typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function normalizeJob(job) {
  return {
    ...job,
    payload: parsePossiblyJson(job.payload),
    result: parsePossiblyJson(job.result),
    error: parsePossiblyJson(job.error)
  };
}

function toDockerImageName(functionName) {
  const normalized = String(functionName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!normalized) {
    throw new Error("Function name must contain letters or numbers");
  }

  return `cloudfunc-${normalized}:latest`;
}

async function getFunctionOrThrow(functionName) {
  const response = await axios.get(`${REGISTRY_URL}/functions/${functionName}`);
  return response.data;
}

async function buildAndRegisterFunction({ name, runtime, code, ownerUsername }) {
  const dir = path.join(__dirname, `tmp-function-${name}-${Date.now()}`);
  const imageName = toDockerImageName(name);

  fs.mkdirSync(dir, { recursive: true });

  try {
    fs.writeFileSync(path.join(dir, "handler.js"), code);
    fs.copyFileSync(path.join(__dirname, "runner.js"), path.join(dir, "runner.js"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          name: `function-${name}`,
          version: "1.0.0",
          main: "runner.js",
          dependencies: {
            express: "^4.18.2"
          }
        },
        null,
        2
      )
    );

    const dockerfile = `
FROM node:18-alpine

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 4000

CMD ["node", "runner.js"]
`;

    fs.writeFileSync(path.join(dir, "Dockerfile"), dockerfile.trimStart());

    await new Promise((resolve, reject) => {
      exec(`docker build -t ${imageName} "${dir}"`, (error, stdout, stderr) => {
        if (error) {
          console.error(stdout);
          console.error(stderr);
          return reject(new Error("Docker build failed"));
        }

        console.log(stdout);
        resolve();
      });
    });

    await axios.post(`${REGISTRY_URL}/functions`, {
      name,
      imageName,
      runtime,
      ownerUsername
    });

    return { imageName };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function handleFunctionRegistration(req, res) {
  const { name, runtime, code } = req.body;

  if (!name || !runtime || !code) {
    return res.status(400).json({
      error: "name, runtime and code are required"
    });
  }

  try {
    const result = await buildAndRegisterFunction({
      name,
      runtime,
      code,
      ownerUsername: req.user.username
    });

    return res.status(201).json({
      message: "Function registered successfully",
      image: result.imageName
    });
  } catch (error) {
    console.error("Function registration failed:", error.message);

    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: error.message || "Function registration failed"
    });
  }
}

async function handleInvocation(req, res) {
  const { functionName, payload } = req.body;

  if (!functionName || payload === undefined) {
    return res.status(400).json({
      error: "functionName and payload are required"
    });
  }

  try {
    await getFunctionOrThrow(functionName);

    const jobId = uuidv4();

    await axios.post(`${REGISTRY_URL}/jobs`, {
      jobId,
      functionName,
      payload
    });

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

    return res.status(200).json({ jobId });
  } catch (error) {
    console.error("Invocation failed:", error.message);

    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Internal Gateway Error"
    });
  }
}

async function handleSingleJobLookup(req, res) {
  try {
    const response = await axios.get(`${REGISTRY_URL}/jobs/${req.params.jobId}`);
    const job = normalizeJob(response.data);

    if (
      job.owner_username &&
      job.owner_username !== req.user.username &&
      req.query.scope !== "all"
    ) {
      return res.status(403).json({
        error: "You do not have access to this job"
      });
    }

    return res.json(job);
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Gateway error retrieving job"
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "gateway",
    rabbitmqConnected: Boolean(channel)
  });
});

app.post("/auth/register", async (req, res) => {
  const { username, email, password, displayName } = req.body;

  try {
    const response = await axios.post(`${REGISTRY_URL}/users/register`, {
      username,
      email,
      password,
      displayName
    });

    const token = signToken(response.data.user);

    return res.status(201).json({
      token,
      user: formatUserResponse(response.data.user)
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Registration failed"
    });
  }
});

app.post("/auth/login", async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const response = await axios.post(`${REGISTRY_URL}/users/login`, {
      username,
      email,
      password
    });

    const token = signToken(response.data.user);

    return res.json({
      token,
      user: formatUserResponse(response.data.user)
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Login failed"
    });
  }
});

app.get("/auth/me", authenticateToken, (req, res) => {
  res.json({
    user: {
      id: req.user.sub,
      username: req.user.username,
      email: req.user.username,
      displayName: req.user.displayName
    }
  });
});

app.get("/api/templates", authenticateToken, (_req, res) => {
  res.json(templateLibrary);
});

app.get("/api/dashboard", authenticateToken, async (req, res) => {
  try {
    const [summaryResponse, functionsResponse, jobsResponse] = await Promise.all([
      axios.get(`${REGISTRY_URL}/analytics/summary`, {
        params: { owner: req.user.username }
      }),
      axios.get(`${REGISTRY_URL}/functions`, {
        params: { owner: req.user.username }
      }),
      axios.get(`${REGISTRY_URL}/jobs`, {
        params: { owner: req.user.username, limit: 8 }
      })
    ]);

    return res.json({
      stats: summaryResponse.data.stats,
      recentJobs: summaryResponse.data.recentJobs.map(normalizeJob),
      functions: functionsResponse.data,
      jobs: jobsResponse.data.map(normalizeJob)
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to load dashboard"
    });
  }
});

app.get("/api/functions", authenticateToken, async (req, res) => {
  try {
    const params = {
      search: req.query.search || undefined,
      owner: req.query.scope === "all" ? undefined : req.user.username
    };
    const response = await axios.get(`${REGISTRY_URL}/functions`, { params });
    return res.json(response.data);
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to fetch functions"
    });
  }
});

app.get("/api/functions/:name", authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(`${REGISTRY_URL}/functions/${req.params.name}`);
    const fn = response.data;

    if (fn.owner_username && fn.owner_username !== req.user.username) {
      return res.status(404).json({
        error: "Function not found"
      });
    }

    return res.json(fn);
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to fetch function"
    });
  }
});

app.post("/api/functions", authenticateToken, handleFunctionRegistration);
app.post("/register", authenticateToken, handleFunctionRegistration);

app.delete("/api/functions/:name", authenticateToken, async (req, res) => {
  try {
    const existing = await getFunctionOrThrow(req.params.name);

    if (existing.owner_username && existing.owner_username !== req.user.username) {
      return res.status(403).json({
        error: "Only the owner can delete this function"
      });
    }

    const response = await axios.delete(`${REGISTRY_URL}/functions/${req.params.name}`);
    return res.json(response.data);
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to delete function"
    });
  }
});

app.post("/api/invoke", authenticateToken, handleInvocation);
app.post("/invoke", authenticateToken, handleInvocation);

app.get("/api/jobs", authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(`${REGISTRY_URL}/jobs`, {
      params: {
        owner: req.query.scope === "all" ? undefined : req.user.username,
        search: req.query.search || undefined,
        status: req.query.status || undefined,
        functionName: req.query.functionName || undefined,
        limit: req.query.limit || 50
      }
    });

    return res.json(response.data.map(normalizeJob));
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to fetch jobs"
    });
  }
});

app.get("/api/jobs/:jobId", authenticateToken, handleSingleJobLookup);
app.get("/jobs/:jobId", authenticateToken, handleSingleJobLookup);

app.use(express.static(publicDir));

app.use((req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/auth")) {
    return next();
  }

  return res.sendFile(path.join(publicDir, "index.html"));
});

async function startServer() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertQueue("executions", { durable: true });

    console.log("Connected to RabbitMQ");

    app.listen(PORT, () => {
      console.log(`Gateway running on port ${PORT}`);
    });
  } catch (error) {
    console.error("RabbitMQ connection error:", error.message);
    process.exit(1);
  }
}

startServer();
