# CloudFunc

> Lightweight serverless function execution platform built with Node.js, Docker, RabbitMQ, and PostgreSQL — similar to a simplified AWS Lambda.

---

## Architecture

```
User → Gateway → Function Registry → RabbitMQ → Worker → Container Manager → Docker Containers
```

| Component | Role | Port |
|---|---|---|
| Gateway | Entry point for all client requests | 8080 |
| Function Registry | Stores function metadata (PostgreSQL) | 3000 |
| Worker | Consumes jobs from RabbitMQ | — |
| Container Manager | Manages Docker containers | 4001 |
| Function Runner | Runs functions inside containers | 4000 |

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Node.js | Backend services |
| Express.js | REST APIs |
| Docker | Function execution environment |
| RabbitMQ | Asynchronous message queue |
| PostgreSQL | Metadata and job status storage |
| concurrently | Run all services with one command |

---

## Project Structure

```
CloudFunc/
├── gateway/
│   └── gateway.js
├── registry/
│   ├── index.js
│   ├── db.js
│   ├── schema.sql
│   └── routes/
│       ├── functions.js
│       └── jobs.js
├── worker service/
│   ├── Worker/
│   │   └── index.js
│   ├── container-manager/
│   │   └── manager.js
│   └── function-runner/
│       └── runner.js
└── package.json
```

---

## Prerequisites

- Node.js v18+
- Docker Desktop (must be running)
- npm

---

## Setup & Start Guide

### Step 1: Clone the Repository

```bash
git clone https://github.com/j1y4-j/Group-A-Cloudfunc.git
cd Group-A-Cloudfunc/CloudFunc
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Start PostgreSQL

Run once. Skip if already running.

```bash
docker run -d \
  -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cloudfunc \
  postgres
```

### Step 4: Start RabbitMQ

Run once. Skip if already running.

```bash
docker run -d \
  --name cloudfunc-rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:3-management
```

On subsequent runs, just restart existing containers:

```bash
docker start cloudfunc-rabbitmq
docker start <postgres-container-id>   # get ID from: docker ps -a
```

### Step 5: Initialize the Database

Run once to create the required tables:

```bash
docker exec -i <postgres-container-id> psql -U postgres -d cloudfunc < registry/schema.sql
```

### Step 6: Start All Services

```bash
npm start
```

This starts all 5 services simultaneously: Gateway, Registry, Worker, Container Manager, and Function Runner.

---

## API Usage

### 1. Register a Function

```
POST http://localhost:8080/register
```

```json
{
  "name": "sum",
  "runtime": "nodejs",
  "code": "const p = JSON.parse(process.env.PAYLOAD || '{}'); console.log(p.a + p.b);"
}
```

### 2. Invoke a Function

```
POST http://localhost:8080/invoke
```

```json
{
  "functionName": "sum",
  "payload": { "a": 5, "b": 7 }
}
```

Response:

```json
{ "jobId": "87cbd05a-44bb-4865-b2a5-83c6bb5840ce" }
```

### 3. Check Job Status

```
GET http://localhost:8080/jobs/:jobId
```

| Status | Meaning |
|---|---|
| `queued` | Job received, waiting for worker |
| `running` | Worker is executing the function |
| `completed` | Function ran successfully |
| `failed` | All retry attempts exhausted |

---

## Example Functions

**Sum two numbers:**

```js
const payload = JSON.parse(process.env.PAYLOAD || '{}');
console.log(payload.a + payload.b);
```

**Reverse a string:**

```js
const payload = JSON.parse(process.env.PAYLOAD || '{}');
console.log(payload.text.split('').reverse().join(''));
```

---

## Troubleshooting

| Error | Fix |
|---|---|
| `ECONNREFUSED` on port 8080 | Ensure `npm start` is running and RabbitMQ is up |
| Port 4000 already in use | `manager.js` uses 4001, `runner.js` uses 4000 — do not change either |
| `relation 'jobs' does not exist` | Run Step 5 (schema.sql) against your PostgreSQL container |
| `Worker/index.js` not found | Run `npm start` from the `CloudFunc` root directory |
| RabbitMQ connection error | Run `docker start cloudfunc-rabbitmq` |

---

## Features

- Serverless function registration via API
- Docker-based isolated function execution
- Asynchronous job processing with RabbitMQ
- Warm container reuse to reduce cold start latency
- Job status tracking with PostgreSQL
- Worker retry mechanism for failed jobs
- Recovery of queued jobs after worker restart