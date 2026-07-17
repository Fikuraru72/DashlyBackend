# Dashly Backend

Real-time event tracking backend for Dashly. Built with NestJS, PostgreSQL, Drizzle ORM, Redis, MQTT, Socket.IO, and OSRM route normalization via public demo server.

## Stack

- Framework: NestJS
- Database: PostgreSQL
- ORM: Drizzle ORM
- Cache/geospatial state: Redis
- Ingestion broker: MQTT
- Realtime updates: Socket.IO
- Route normalization: OSRM public demo server
- Package manager: `vp`

## Data flow

1. Mobile participants publish GPS telemetry over MQTT.
2. Backend validates and ingests telemetry.
3. Latest positions and geospatial state live in Redis.
4. Live updates are broadcast over Socket.IO.
5. Historical tracking data is persisted to PostgreSQL.
6. Fixed event routes are normalized through OSRM public demo before storage when enabled.

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

Dashly can normalize fixed event routes through the public OSRM demo server. No OSRM Docker service or local map data is required.

```env
OSRM_ENABLED=true
OSRM_URL=https://router.project-osrm.org
OSRM_PROFILE=bike
```

The public demo server is for light, non-commercial usage only. Keep usage under 1 request/second; backend falls back to the raw route if OSRM fails.

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
OSRM_URL=https://router.project-osrm.org
OSRM_PROFILE=bike
```
