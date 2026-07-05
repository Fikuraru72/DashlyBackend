# Dashly Backend

Real-time event tracking backend for Dashly. Built with NestJS, PostgreSQL, Drizzle ORM, Redis, MQTT, and Socket.IO.

## Stack

- Framework: NestJS
- Database: PostgreSQL
- ORM: Drizzle ORM
- Cache/geospatial state: Redis
- Ingestion broker: MQTT
- Realtime updates: Socket.IO
- Package manager: `vp`

## Data flow

1. Mobile participants publish GPS telemetry over MQTT.
2. Backend validates and ingests telemetry.
3. Latest positions and geospatial state live in Redis.
4. Live updates are broadcast over Socket.IO.
5. Historical tracking data is persisted to PostgreSQL.
6. Fixed event routes are stored from uploaded GPX/manual GeoJSON.

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
```
