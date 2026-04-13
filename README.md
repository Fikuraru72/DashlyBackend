# Dashly Backend

Dashly is a high-performance, real-time location tracking and event management backend. It is designed to handle high-frequency GPS telemetry from thousands of mobile devices, process anomalies in real-time, and broadcast live updates to a web dashboard.

## 🚀 Tech Stack & Architecture

- **Framework**: [NestJS](https://nestjs.com/) (Node.js)
- **Database**: PostgreSQL
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **In-Memory Store & Geospatial**: Redis
- **Message Broker (Ingestion)**: EMQX (MQTT)
- **Real-Time Broadcasting**: WebSockets (Socket.io)

### How Data Flows

1. **Runners (Mobile App / Participants)** publish their GPS coordinates at high frequency (e.g., every 3s) via **MQTT** to the EMQX broker. MQTT provides low latency and low battery overhead for mobile clients.
2. **NestJS (`MqttService`)** subscribes to the EMQX broker, validating and ingesting the location data.
3. The data is instantly written to **Redis** for fast, ephemeral state storage and geospatial calculations (e.g., distancing, anomalies).
4. The live data is then broadcasted via **WebSockets (`EventsGateway`)** to any connected admin dashboards or spectator screens.
5. In the background, data points are batched and periodically flushed to **PostgreSQL** for persistent tracking history.

---

## 🛠️ Prerequisites

Make sure you have the following installed to run this project:

- Node.js (v18+)
- `pnpm` or `npm`
- Docker & Docker Compose (for PostgreSQL, Redis, and EMQX)

---

## 📦 Setup & Installation

### 1. Start External Services (Infrastructure)

Ensure you have your Docker containers running for PostgreSQL, Redis, and EMQX.

```bash
docker-compose up -d
```

_(Note: If you are running these services manually or externally, make sure they match the ports in your `.env` file)._

### 2. Install Dependencies

```bash
pnpm install
# or
npm install
```

### 3. Environment Variables

Create a `.env` file in the root directory (or use the provided `.env.example` if available) and configure your connection strings:

```env
# Database
DATABASE_URL="postgres://postgres:password@localhost:5432/dashly"

# JWT Auth
JWT_SECRET="your_super_secret_key"

# MQTT Broker (EMQX)
MQTT_HOST="localhost"
MQTT_PORT=1883

# Redis
REDIS_HOST="localhost"
REDIS_PORT=6379
```

### 4. Database Schema & Seeding

Push the database schema using Drizzle, and then seed the database with the initial roles and MVP test data.

```bash
# Push schema to PostgreSQL
pnpm run db:push    # or npx drizzle-kit push

# Seed the MVP Prototype data (Roles, Users, Mocks)
npx ts-node src/db/seed-prototype.ts
```

### 5. Start the Backend Server

```bash
# Development watchdog mode
pnpm run start:dev  # or npm run start:dev
```

The REST API and WebSocket server will both be available at `http://localhost:3000`.

---

## 🧪 Running the MVP Prototype Simulation

To verify that the entire end-to-end telemetry pipeline is working (REST -> MQTT -> Redis -> NestJS -> WebSockets) without needing a frontend or mobile app, you can run the provided prototype simulators.

Make sure your backend server (`npm run start:dev`) is already running.

1. **Start the Dashboard Simulator (Admin)**
   Open a new terminal window and run:

   ```bash
   npx ts-node prototype/admin-simulation.ts
   ```

   _This script logs in as the Super Admin, grabs the current Active Event, connects to the WebSocket room, and listens for live location updates._

2. **Start the Runner Simulators (Participants)**
   Open another new terminal window and run:
   ```bash
   npx ts-node prototype/participant-simulation.ts
   ```
   _This script logs in 10 mock runners simultaneously and starts blasting coordinates (with slight randomized jitter) to the MQTT broker over a predetermined path._

**If successful**, you will immediately see live GPS coordinates streaming into your **Admin Terminal** via WebSockets!

---

## 🔐 Authentication & Roles

The system uses JWT for securing Endpoints and Socket rooms. There are three core roles seeded by default:

- `SUPER_ADMIN` (`admin@dashly.com`) - Full access to manage events.
- `STAFF` (`staff@dashly.com`) - Can view and manage assigned events.
- `PARTICIPANT` (`participant@dashly.com` / `runnerX@dashly.com`) - Mobile users who can join events and broadcast locations.

_(All seeded user passwords are: `password123`)_
