# Dashly Backend

Real-time event tracking backend for Dashly. Built with NestJS, PostgreSQL, Drizzle ORM, Redis, MQTT, Socket.IO, and OSRM route normalization.

## Stack

- Framework: NestJS
- Database: PostgreSQL
- ORM: Drizzle ORM
- Cache/geospatial state: Redis
- Ingestion broker: MQTT
- Realtime updates: Socket.IO
- Route normalization: OSRM bicycle profile
- Package manager: `vp`

## Data flow

1. Mobile participants publish GPS telemetry over MQTT.
2. Backend validates and ingests telemetry.
3. Latest positions and geospatial state live in Redis.
4. Live updates are broadcast over Socket.IO.
5. Historical tracking data is persisted to PostgreSQL.
6. Fixed event routes are normalized through OSRM before storage or GPX upload response.

## Prerequisites

- Node.js 24+
- `vp`
- Docker and Docker Compose

## Setup

Install dependencies:

```bash
vp install
```

Copy env file:

```bash
cp .env.example .env
```

Start infrastructure:

```bash
docker compose up -d postgres redis mosquitto
```

Prepare database:

```bash
vp exec drizzle-kit push
vp run seed
```

Start backend:

```bash
vp run start:dev
```

API runs at:

```text
http://localhost:3000
```

Default seeded admin:

```text
admin@dashly.com / password123
```

## OSRM route normalization

Dashly uses OSRM only for fixed event routes:

- `POST /events/upload-gpx`
- `POST /events`
- `PUT /events/:id`

No tracking ingestion route is normalized through OSRM.

Profile:

- Cycling and running both use `osrm-profiles/bicycle.lua`.

Behavior:

- Routes prefer cycleways, paths, residential roads, and safer roads.
- Primary and secondary vehicle roads are penalized.
- If OSRM fails or is offline, backend falls back to the raw route.

Prepare OSRM data:

```bash
vp run osrm:prepare
```

Start OSRM services:

```bash
vp run osrm:up
```

OSRM service:

```text
bicycle: http://localhost:5000
```

Current MVP map extract is East Java. To switch to full Indonesia later, update `OSRM_PBF_URL` in `.env` and rerun `vp run osrm:prepare`.

## Commands

Build:

```bash
vp run build
```

Run production build:

```bash
vp run start:prod
```

Format:

```bash
vp run format
```

Lint:

```bash
vp run lint
```

Unit tests:

```bash
vp run test
```

E2E tests:

```bash
vp run test:e2e
```

OSRM k6 e2e load test under constrained runtime:

```bash
vp run osrm:e2e:k6
```

Custom load:

```bash
VUS=20 DURATION=1m vp run osrm:e2e:k6
```

The k6 script runs the backend with:

- 2 CPU cores via `taskset -c 0,1`
- 2 GB Node heap via `NODE_OPTIONS=--max-old-space-size=2048`
- k6 Docker runner limited to 2 CPU and 2 GB RAM

## Authentication and roles

JWT protects private HTTP routes and WebSocket connections.

Seeded roles:

- `SUPER_ADMIN`: full event access
- `STAFF`: assigned event management
- `PARTICIPANT`: event join and tracking user

Seeded passwords are `password123`.

## Environment variables

Required core variables:

```env
DATABASE_URL=postgres://dashly_user:dashly_password@localhost:5432/dashly_db
JWT_SECRET=change_me
REDIS_HOST=localhost
REDIS_PORT=6379
MQTT_HOST=localhost
MQTT_PORT=1883
OSRM_ENABLED=true
OSRM_BICYCLE_URL=http://localhost:5000
OSRM_PBF_URL=https://geo2day.com/asia/indonesia/east_java.pbf
```
