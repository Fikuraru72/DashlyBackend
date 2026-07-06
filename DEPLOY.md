# Dashly Production Deploy: Rocky Linux VPS

Target:

- Frontend: Vercel or Cloudflare Pages
- Backend: Rocky Linux VPS
- DB: local Postgres container or Supabase
- Redis, Mosquitto: VPS Docker
- Route normalization: OSRM public demo server
- Reverse proxy: Caddy

## Server size

2 CPU / 2GB RAM is enough for MVP if:

- VPS has 4GB swap.
- Postgres/Redis/MQTT bind to localhost only.
- OSRM uses the public demo server, not local Docker.

Not enough for large concurrent events. Use Supabase if local Postgres eats too much RAM.

## 1. Bootstrap VPS

```bash
ssh root@VPS_IP
mkdir -p /opt/dashly
cd /opt/dashly
git clone <backend-repo-url> DashlyBackend
cd DashlyBackend
bash scripts/prod-bootstrap.sh
```

Install/copy `vp` if missing:

```bash
which vp || echo "install vp first"
```

## 2. Create `.env`

### Option A: local Postgres on VPS

```env
NODE_ENV=production
PORT=3000

DATABASE_URL=postgresql://dashly_user:CHANGE_ME@localhost:5432/dashly_db
POSTGRES_DB=dashly_db
POSTGRES_USER=dashly_user
POSTGRES_PASSWORD=CHANGE_ME

JWT_SECRET=CHANGE_ME_LONG_RANDOM

REDIS_HOST=redis
REDIS_PORT=6379

MQTT_HOST=mosquitto
MQTT_PORT=1883

OSRM_ENABLED=true
OSRM_URL=https://router.project-osrm.org
OSRM_PROFILE=bike
```

### Option B: Supabase Postgres

```env
NODE_ENV=production
PORT=3000

DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require
JWT_SECRET=CHANGE_ME_LONG_RANDOM

REDIS_HOST=redis
REDIS_PORT=6379

MQTT_HOST=mosquitto
MQTT_PORT=1883

OSRM_ENABLED=true
OSRM_URL=https://router.project-osrm.org
OSRM_PROFILE=bike
```

Notes:

- Prefer Supabase pooler URL for app runtime.
- Keep `sslmode=require`.
- Public OSRM demo is light-use only: keep under ~1 request/second, no SLA.
- Backend falls back to raw GPX route if OSRM fails.

## 3. Install systemd service

```bash
cd /opt/dashly/DashlyBackend
bash scripts/install-systemd.sh
```

If `vp` path differs:

```bash
VP_BIN=$(which vp) bash scripts/install-systemd.sh
```

## 4. Deploy backend + infra

```bash
cd /opt/dashly/DashlyBackend
bash scripts/prod-deploy.sh
```

What it does:

- Starts Redis and Mosquitto.
- Starts local Postgres only when `DATABASE_URL` points to localhost.
- Removes local Postgres container when using Supabase.
- Builds backend.
- Runs Drizzle migrations.
- Restarts `dashly-backend` service.

## 5. Configure HTTPS domain

Point DNS `api.example.com` to VPS IP.

```bash
bash scripts/install-caddy.sh api.example.com
```

## 6. Firewall

Handled by `prod-bootstrap.sh` on Rocky Linux using `firewalld`.

```text
Open: 22, 80, 443, 1883 (MQTT)
Closed/public-blocked: 3000, 5432, 6379
```

Verify:

```bash
sudo firewall-cmd --list-all
ss -tulpn
```

Expected Docker port binds are `127.0.0.1`, not `0.0.0.0`.

## 7. Smoke test

```bash
curl https://api.example.com
sudo journalctl -u dashly-backend -f
```

Optional OSRM demo check:

```bash
curl 'https://router.project-osrm.org/route/v1/bike/106.8227,-6.1744;106.8287,-6.1804?overview=full&geometries=geojson&steps=false'
```

## 8. Frontend deploy

Set frontend env:

```env
NEXT_PUBLIC_API_URL=https://api.example.com
```

Deploy to Vercel or Cloudflare Pages.

## Cloudflare free

Good for:

- DNS
- TLS proxy
- Frontend static/Next output on Cloudflare Pages
- Proxy HTTPS API to VPS

Not good for:

- NestJS long-running backend
- Redis
- MQTT TCP broker
- Postgres

Cloudflare Tunnel can hide VPS 80/443, but Caddy + firewall is simpler for MVP.

## Useful commands

```bash
# backend logs
sudo journalctl -u dashly-backend -f

# restart backend
sudo systemctl restart dashly-backend

# docker logs
docker logs -f dashly_redis
docker logs -f dashly_mosquitto

# update deploy
git pull
bash scripts/prod-deploy.sh
```
