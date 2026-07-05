# Dashly Production Deploy: 2 CPU / 2GB RAM

Target:

- Frontend: Vercel or Cloudflare Pages
- Backend: VPS
- DB: local Postgres container or Supabase
- Redis, Mosquitto: VPS Docker
- Route normalization: OSRM public demo server
- Reverse proxy: Caddy

## Is 2 CPU / 2GB enough?

Enough for MVP if:

- VPS has 4GB swap.
- Postgres/Redis/MQTT are not publicly exposed.

Not enough for:

- Large concurrent events.

## 1. Bootstrap VPS

```bash
ssh user@VPS_IP
sudo mkdir -p /opt/dashly
sudo chown $USER:$USER /opt/dashly
cd /opt/dashly
git clone <backend-repo-url> DashlyBackend
cd DashlyBackend
bash scripts/prod-bootstrap.sh
```

Install/copy `vp` if missing:

```bash
# install vp using your normal Vite Plus install flow
which vp || echo "install vp first"
```

## 3. Create `.env`

### Option A: local Postgres on VPS

```env
NODE_ENV=production
PORT=3000

DATABASE_URL=postgresql://dashly_user:CHANGE_ME@localhost:5432/dashly_db
POSTGRES_DB=dashly_db
POSTGRES_USER=dashly_user
POSTGRES_PASSWORD=CHANGE_ME

JWT_SECRET=CHANGE_ME_LONG_RANDOM

REDIS_HOST=localhost
REDIS_PORT=6379

MQTT_HOST=localhost
MQTT_PORT=1883

OSRM_ENABLED=true
OSRM_URL=https://router.project-osrm.org
OSRM_PROFILE=bike

```

### Option B: Supabase Postgres

Use Supabase if you want less RAM pressure on VPS.

```env
NODE_ENV=production
PORT=3000

DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require
JWT_SECRET=CHANGE_ME_LONG_RANDOM

REDIS_HOST=localhost
REDIS_PORT=6379

MQTT_HOST=localhost
MQTT_PORT=1883

OSRM_ENABLED=true
OSRM_URL=https://router.project-osrm.org
OSRM_PROFILE=bike

```

Notes:

- Prefer Supabase pooler URL for app runtime.
- For migrations, direct DB URL is also okay if Supabase allows it.
- Keep `sslmode=require`.
- Supabase free is okay for MVP, but watch DB size, connection limits, and latency.

## 4. Install systemd service

On VPS:

```bash
cd /opt/dashly/DashlyBackend
bash scripts/install-systemd.sh
```

If `vp` path differs:

```bash
VP_BIN=$(which vp) bash scripts/install-systemd.sh
```

## 6. Deploy backend + infra

```bash
cd /opt/dashly/DashlyBackend
bash scripts/prod-deploy.sh
```

What it does:

- Starts Docker infra.
- Uses local Postgres only when `DATABASE_URL` points to localhost.
- Stops/removes local Postgres container when using Supabase.
- Builds backend.
- Runs Drizzle migrations.
- Restarts `dashly-backend` service.

## 7. Configure HTTPS domain

Point DNS `api.example.com` to VPS IP.

Then:

```bash
bash scripts/install-caddy.sh api.example.com
```

## 8. Firewall

Already handled by `prod-bootstrap.sh`:

```text
Open: 22, 80, 443
Closed/public-blocked: 3000, 5432, 6379, 1883
```

Verify:

```bash
sudo ufw status
ss -tulpn
```

Expected Docker port binds are `127.0.0.1`, not `0.0.0.0`.

## 9. Smoke test

```bash
curl https://api.example.com
sudo journalctl -u dashly-backend -f
```

## 10. Frontend deploy

Set frontend env:

```env
NEXT_PUBLIC_API_URL=https://api.example.com
```

Deploy to Vercel or Cloudflare Pages.

## Cloudflare free: bisa?

Bisa untuk:

- DNS
- TLS proxy
- Frontend static/Next output on Cloudflare Pages
- Proxy HTTPS API to VPS

Tidak cocok untuk full backend ini:

- NestJS long-running server
- Redis
- MQTT TCP broker
- Postgres

Cloudflare Workers free juga tidak cocok untuk backend ini karena backend butuh long-running Node server, Docker services, dan TCP/MQTT. Tetap butuh VPS.

Cloudflare Tunnel bisa dipakai supaya VPS tidak expose port 80/443 langsung, tapi untuk MVP Caddy + firewall lebih simpel.

## Supabase: perlu ubah kode?

Biasanya tidak.

Cukup ganti `DATABASE_URL` ke Supabase Postgres dengan `sslmode=require`.

Yang perlu diperhatikan:

- Jangan jalankan local Postgres kalau pakai Supabase.
- Migration tetap pakai `vp exec drizzle-kit migrate`.
- Kalau koneksi pooler bermasalah saat migrate, pakai direct Supabase DB URL untuk migration.
- Latency DB sedikit naik karena DB di luar VPS.

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
