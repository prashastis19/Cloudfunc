# CloudFunc

CloudFunc is a lightweight serverless function execution platform built with Node.js, Docker, RabbitMQ, PostgreSQL, and a browser-based control panel.

It lets a user:

- register with mail ID and password
- create functions from templates or custom handler code
- invoke functions with JSON arguments
- track queued, running, completed, and failed jobs
- manage only their own functions and runs through JWT-protected APIs

## Highlights

- Multi-service architecture with gateway, registry, worker, and container manager
- JWT-based authentication for frontend and API access
- PostgreSQL-backed user, function, and job metadata
- RabbitMQ queue for asynchronous execution
- Docker-based isolated function execution
- Warm container reuse for faster repeated invocations
- Search-first frontend flow for registering, finding, and invoking functions
- Live result updates and recent job history in the UI

## Architecture

```text
Frontend UI
    |
    v
Gateway (auth, frontend APIs, Docker build trigger)
    |
    +--> Registry (users, functions, jobs, analytics) --> PostgreSQL
    |
    +--> RabbitMQ queue --> Worker --> Container Manager --> Function Container
```

### Service Responsibilities

- `gateway/`
  - serves the frontend
  - handles login and registration
  - signs and verifies JWT tokens
  - builds Docker images for user functions
  - exposes authenticated UI-facing APIs

- `registry/`
  - stores users, functions, jobs, and analytics in PostgreSQL
  - auto-creates required tables on startup

- `worker service/Worker/`
  - consumes queued jobs from RabbitMQ
  - updates job state in the registry
  - retries failed executions

- `worker service/container-manager/`
  - starts or reuses function containers
  - calls the runtime runner inside the container
  - cleans up idle containers

- `worker service/function-runner/`
  - contains the runtime entrypoint used inside each generated function container

## Project Structure

```text
CloudFunc/
├── gateway/
│   ├── gateway.js
│   ├── runner.js
│   ├── .env
│   └── public/
├── registry/
│   ├── index.js
│   ├── db.js
│   ├── schema.sql
│   ├── .env
│   └── routes/
├── worker service/
│   ├── Worker/
│   │   ├── index.js
│   │   └── .env
│   ├── container-manager/
│   │   ├── manager.js
│   │   └── .env
│   └── function-runner/
│       └── runner.js
├── package.json
└── README.md
```

## Requirements

- Ubuntu terminal
- Node.js 18 or newer
- npm
- Docker
- RabbitMQ
- PostgreSQL

Docker Compose is optional. This project can be run using plain Docker commands.

## How It Works

### Function Registration Flow

1. User logs in through the frontend
2. Gateway verifies JWT and accepts function metadata + handler code
3. Gateway creates a temporary build folder
4. Gateway writes:
   - `handler.js`
   - runtime `runner.js`
   - `package.json`
   - `Dockerfile`
5. Gateway builds a Docker image
6. Gateway stores function metadata in the registry

### Function Invocation Flow

1. User searches for a function in the frontend
2. Gateway verifies the function exists and belongs to the logged-in user
3. Gateway creates a job in the registry
4. Gateway pushes the job to RabbitMQ
5. Worker picks the job
6. Container manager starts or reuses a warm container
7. Runner executes the handler with JSON payload
8. Worker updates job result in PostgreSQL
9. Frontend polls the latest job result and updates the UI

## Ubuntu Setup

Move into the project folder:

```bash
cd "/mnt/c/Users/M K Vasudev/OneDrive/Desktop/iste/Group-A-Cloudfunc/CloudFunc"
```

Install dependencies:

```bash
npm install
```

## Start PostgreSQL In Docker

This README uses PostgreSQL on host port `5433`.

- database: `cloudfunc`
- username: `postgres`
- password: `postgres`

Run:

```bash
docker run -d \
  --name cloudfunc-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cloudfunc \
  -p 5433:5432 \
  postgres:16
```

## Start RabbitMQ In Docker

Run:

```bash
docker run -d \
  --name cloudfunc-rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  rabbitmq:3-management
```

RabbitMQ dashboard:

```text
http://localhost:15672
```

Login:

```text
guest / guest
```

## Environment Files

Each service loads its own `.env` file directly, so create the files in the exact folders shown below.

### `gateway/.env`

```env
PORT=8080
REGISTRY_URL=http://localhost:3000
RABBITMQ_URL=amqp://localhost
JWT_SECRET=change-this-to-a-long-random-secret
JWT_TTL_HOURS=12
```

### `registry/.env`

```env
REGISTRY_PORT=3000
POSTGRES_HOST=localhost
POSTGRES_PORT=5433
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=cloudfunc
```

### `worker service/Worker/.env`

```env
RABBITMQ_URL=amqp://localhost:5672
REGISTRY_URL=http://localhost:3000
CONTAINER_URL=http://localhost:4001
```

### `worker service/container-manager/.env`

```env
PORT=4001
REGISTRY_URL=http://localhost:3000
```

## Run The Platform

From the project root:

```bash
npm start
```

This starts:

- Gateway on `http://localhost:8080`
- Registry on `http://localhost:3000`
- Container Manager on `http://localhost:4001`
- Worker service in the background

## Open The Frontend

Go to:

```text
http://localhost:8080
```

Recommended demo flow:

1. Register a new account
2. Log in
3. Register a function using a starter template or custom code
4. Search for the function in the invoke panel
5. Provide JSON arguments
6. Run the function
7. View updated result and job history

## Auth Model

- Registration and login happen through the gateway
- Gateway signs JWTs
- Frontend stores the token in local storage
- Authenticated frontend APIs automatically send `Authorization: Bearer <token>`
- Users only see and manage their own functions and jobs by default

## Main API Endpoints

### Auth

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`

### Frontend APIs

- `GET /api/dashboard`
- `GET /api/templates`
- `GET /api/functions`
- `GET /api/functions/:name`
- `POST /api/functions`
- `DELETE /api/functions/:name`
- `POST /api/invoke`
- `GET /api/jobs`
- `GET /api/jobs/:jobId`

### Legacy Authenticated Routes

- `POST /register`
- `POST /invoke`
- `GET /jobs/:jobId`

## Notes

- The registry creates the required schema automatically on startup.
- Docker must remain available because user functions are built and executed as containers.
- Function image names are normalized to Docker-safe lowercase names during build.
- Function deletion removes metadata from the registry, but it does not currently remove built Docker images.
- The frontend is intentionally focused on the logged-in user’s workspace and recent activity.

## Troubleshooting

### 1. Registry fails to start

Check:

- PostgreSQL container is running
- `registry/.env` matches the actual Postgres host, port, username, password, and database

Useful command:

```bash
docker logs cloudfunc-postgres
```

### 2. Password authentication failed for user `postgres`

This usually means:

- wrong password in `registry/.env`
- wrong host port
- connecting to a different PostgreSQL instance than expected

### 3. Gateway shows `Docker build failed`

Check:

- Docker daemon is running
- function name is valid
- Docker has permission to build images

### 4. Frontend loads but registration/invocation fails

Check that all services are running:

- gateway on `8080`
- registry on `3000`
- container manager on `4001`
- RabbitMQ on `5672`
- PostgreSQL on configured port

## Useful Commands

Check running containers:

```bash
docker ps
```

Check PostgreSQL logs:

```bash
docker logs cloudfunc-postgres
```

Check RabbitMQ logs:

```bash
docker logs cloudfunc-rabbitmq
```

Stop containers:

```bash
docker stop cloudfunc-postgres cloudfunc-rabbitmq
```

Remove containers:

```bash
docker rm cloudfunc-postgres cloudfunc-rabbitmq
```

## Resume Summary

CloudFunc demonstrates:

- backend service decomposition
- authenticated API design
- async job processing with RabbitMQ
- Docker-based function execution
- PostgreSQL schema and query design
- user-focused frontend workflow for cloud function management

It is a strong foundation for extending into a more production-ready platform with:

- execution logs
- richer observability
- test coverage
- Docker Compose deployment
- resource limits and sandbox hardening
