# ☁️ CloudFunc — Mini Serverless Platform

A lightweight Function-as-a-Service (FaaS) platform built from scratch using Node.js, Docker, RabbitMQ, and PostgreSQL. Inspired by AWS Lambda — deploy any JavaScript function, invoke it on demand, and get results asynchronously.

---

## 📌 What Is This?

CloudFunc lets you:
- **Register** any JavaScript function by sending its code over HTTP
- **Invoke** that function with a payload
- **Get the result** asynchronously via a job ID

You don't manage any servers. The platform handles spinning up Docker containers, executing your function inside them, and returning the result — just like a real serverless platform.

---

## 🏗️ Architecture Overview

```
Client
  │
  ▼
┌─────────────┐
│   Gateway   │  :8080  — Entry point. Handles register, invoke, job status.
└──────┬──────┘
       │
       ├──────────────────────────────────────┐
       │                                      │
       ▼                                      ▼
┌─────────────┐                     ┌──────────────────┐
│  Registry   │  :3000              │    RabbitMQ      │  :5672
│ (PostgreSQL)│                     │  "executions"    │
└─────────────┘                     └────────┬─────────┘
                                             │
                                             ▼
                                    ┌─────────────────┐
                                    │     Worker      │  (no port, consumer only)
                                    └────────┬────────┘
                                             │
                                             ▼
                                    ┌─────────────────────┐
                                    │  Container Manager  │  :4001
                                    └────────┬────────────┘
                                             │
                          ┌──────────────────┼──────────────────┐
                          ▼                  ▼                  ▼
                   [Container]         [Container]         [Container]
                   add fn              multiply fn         divide fn
                   port 7000           port 7001           port 7002
                   runner.js           runner.js           runner.js
                   handler.js          handler.js          handler.js
```

---

## 🧩 Services

| Service | Port | Description |
|---|---|---|
| Gateway | 8080 | Client-facing API. Handles registration, invocation, job status |
| Registry | 3000 | Stores function metadata and job records in PostgreSQL |
| Worker | — | Consumes jobs from RabbitMQ, calls Container Manager |
| Container Manager | 4001 | Manages Docker containers, calls runner via HTTP |
| RabbitMQ | 5672 | Message queue holding pending execution jobs |
| PostgreSQL | 5433 | Database for functions and jobs |
| Runner (inside container) | 4000 | HTTP runtime server inside each function container |

---

## 🔄 How It Works

### Registering a Function

```
POST /register
{
  "name": "add",
  "runtime": "nodejs",
  "code": "module.exports = async (input) => { return input.a + input.b; }"
}
```

1. Gateway checks Registry — rejects immediately if function name already exists
2. Creates a temp build folder with `handler.js`, `runner.js`, `package.json`, `Dockerfile`
3. Builds Docker image `cloudfunc-add:latest`
4. Stores metadata in Registry (PostgreSQL)
5. Deletes temp folder

### Invoking a Function

```
POST /invoke
{
  "functionName": "add",
  "payload": { "a": 5, "b": 3 }
}
```

1. Gateway creates a job (status: `queued`) in Registry
2. Pushes job into RabbitMQ `executions` queue
3. Returns `jobId` immediately — client does not block

### Execution Flow

1. Worker picks job from RabbitMQ
2. Updates job status → `running`
3. Calls Container Manager `POST /execute`
4. Container Manager starts (or reuses) a Docker container
5. Polls `GET /health` until runner is ready
6. Calls `POST /run` on the runner inside the container
7. Runner calls `handler.js` with the payload
8. Result flows back up the chain
9. Worker updates job → `completed` with result

### Checking Result

```
GET /jobs/:jobId
```

Returns job status and result once completed.

---

## 📦 Project Structure

```
Group-A-Cloudfunc/
│
├── gateway/
│   ├── gateway.js          # Entry point API (register, invoke, jobs)
│   └── runner.js           # Runtime server copied into every Docker image
│
├── registry/
│   ├── index.js            # Registry HTTP server
│   ├── db.js               # PostgreSQL connection pool
│   └── routes/
│       ├── functions.js    # GET/POST /functions
│       └── jobs.js         # GET/POST/PATCH /jobs
│
├── worker/
│   └── worker.js           # RabbitMQ consumer with retry + recovery
│
├── container-manager/
│   └── container-manager.js  # Docker management + HTTP runner calls
│
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- [Node.js 18+](https://nodejs.org)
- [Docker](https://www.docker.com)
- [PostgreSQL](https://www.postgresql.org)
- [RabbitMQ](https://www.rabbitmq.com)

### 1. Start RabbitMQ

```bash
docker run -d --name rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:management
```

### 2. Set Up PostgreSQL

Create the database and tables:

```sql
CREATE DATABASE cloudfunc;

\c cloudfunc

CREATE TABLE functions (
  name        VARCHAR(255) PRIMARY KEY,
  image_name  VARCHAR(255) NOT NULL,
  runtime     VARCHAR(50)  NOT NULL DEFAULT 'nodejs',
  created_at  TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE jobs (
  job_id        UUID         PRIMARY KEY,
  function_name VARCHAR(255) REFERENCES functions(name),
  payload       TEXT,
  status        VARCHAR(50)  DEFAULT 'queued',
  result        TEXT,
  error         TEXT,
  attempts      INT          DEFAULT 0,
  submitted_at  TIMESTAMP    DEFAULT NOW(),
  completed_at  TIMESTAMP
);
```

### 3. Install Dependencies

Run `npm install` in each service folder:

```bash
cd gateway && npm install
cd ../registry && npm install
cd ../worker && npm install
cd ../container-manager && npm install
```

### 4. Configure Environment

Create a `.env` file in each service folder:

**gateway/.env**
```
PORT=8080
REGISTRY_URL=http://localhost:3000
RABBITMQ_URL=amqp://localhost
```

**registry/.env**
```
PORT=3000
```

**worker/.env**
```
RABBITMQ_URL=amqp://localhost:5672
REGISTRY_URL=http://localhost:3000
CONTAINER_URL=http://localhost:4001
```

**container-manager/.env**
```
PORT=4001
REGISTRY_URL=http://localhost:3000
```

### 5. Start All Services

Open 4 separate terminals:

```bash
# Terminal 1 — Registry
node registry/index.js

# Terminal 2 — Gateway
node gateway/gateway.js

# Terminal 3 — Container Manager
node container-manager/container-manager.js

# Terminal 4 — Worker
node worker/worker.js
```

---

## 🧪 Testing

### Register a Function

```bash
curl -X POST http://localhost:8080/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "add",
    "runtime": "nodejs",
    "code": "module.exports = async (input) => { return input.a + input.b; }"
  }'
```

Expected response:
```json
{
  "message": "Function registered successfully",
  "image": "cloudfunc-add:latest"
}
```

### Invoke a Function

```bash
curl -X POST http://localhost:8080/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "functionName": "add",
    "payload": { "a": 5, "b": 3 }
  }'
```

Expected response:
```json
{ "jobId": "85466353-5613-4e16-bb4c-d7da72993b39" }
```

### Check Job Result

```bash
curl http://localhost:8080/jobs/85466353-5613-4e16-bb4c-d7da72993b39
```

Expected response:
```json
{
  "job_id": "85466353-5613-4e16-bb4c-d7da72993b39",
  "function_name": "add",
  "status": "completed",
  "result": "{\"success\":true,\"result\":8,\"executionTime\":\"3ms\"}",
  "error": null
}
```

### Register a Second Function to Test Warm Containers

```bash
curl -X POST http://localhost:8080/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "multiply",
    "runtime": "nodejs",
    "code": "module.exports = async (input) => { return input.a * input.b; }"
  }'
```

### Test Duplicate Registration (Should Fail)

```bash
curl -X POST http://localhost:8080/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "add",
    "runtime": "nodejs",
    "code": "module.exports = async (input) => { return input.a + input.b; }"
  }'
```

Expected response:
```json
{
  "error": "Function 'add' already exists. Use a different name."
}
```

---

## ⚙️ Key Design Decisions

### Warm Container Pool
Each function gets one long-running Docker container. After the first invocation (cold start), subsequent invocations reuse the same container — skipping Docker startup entirely and reducing execution time from ~2s to under 100ms.

### Runner as Runtime API
Every function container runs `runner.js` — an Express HTTP server on port 4000. This is the runtime layer between the platform and the user's function. It receives the payload, calls `handler.js`, and returns the result. This is conceptually identical to how AWS Lambda's Runtime API works.

### Asynchronous Execution via RabbitMQ
Invocations are non-blocking. The client gets a `jobId` immediately and polls for the result. Jobs are durably stored in RabbitMQ so they survive worker restarts.

### Retry with Exponential Backoff
Failed jobs are retried up to 3 times with delays of 1s, 2s, and 4s between attempts. This handles temporary failures like container startup delays without hammering the system.

### Job Recovery on Startup
When the worker starts, it fetches all jobs with status `queued` from the database and re-queues them. This ensures no jobs are lost if the worker crashes mid-processing.

### Pre-build Duplicate Check
Before building a Docker image, the gateway checks if a function with that name already exists in the registry. This avoids wasting time on a Docker build that would ultimately be rejected by the database.

---

## 📊 Job Status Flow

```
queued → running → completed
                 → failed
```

Status transitions are strictly enforced by the registry. Invalid transitions (e.g. `queued → completed` directly) are rejected with a 400 error.

---

## 🔌 Port Reference

| What | Host Port | Container Internal Port |
|---|---|---|
| Gateway | 8080 | — |
| Registry | 3000 | — |
| Container Manager | 4001 | — |
| RabbitMQ | 5672 | — |
| Function containers | 7000, 7001, 7002... | 4000 (always) |

Each function container runs `runner.js` internally on port 4000. The container manager maps a unique host port (starting from 7000) to that internal port so multiple containers can run simultaneously without port conflicts.
