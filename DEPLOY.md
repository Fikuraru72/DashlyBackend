# Dashly Production Deployment

Production topology:

```text
Vercel (DashlyDashboard)
       │ HTTPS / Socket.IO
       ▼
Dokploy + Traefik on Rocky Linux
       │
       └── DashlyBackend Compose
           ├── NestJS backend (GHCR image)
           ├── Redis
           ├── Mosquitto
           └── OSRM MLD, bicycle profile, Java OSM extract

DashlyBackend ── TLS ── Supabase PostgreSQL
```

Target server: Rocky Linux 9/10, 6 vCPU, 6 GB RAM, at least 40 GB SSD. Frontend stays on Vercel; PostgreSQL stays on Supabase.

## Versions pinned in this repository

| Component     | Version                             |
| ------------- | ----------------------------------- |
| Bun runtime   | `1.3.14`                            |
| Vite+ build   | `0.2.4`                             |
| OSRM          | `v26.7.3-debian` from official GHCR |
| Redis         | `8.8.0-alpine`                      |
| Mosquitto     | `2.0.22`                            |
| Dokploy       | latest stable at installation time  |
| Java OSM data | Geofabrik `java-latest.osm.pbf`     |

Do not blindly replace pinned images with `latest`. Upgrade deliberately, rebuild OSRM after changing its image version, then run the smoke tests below.

## Resource allocation

Runtime limits in `docker-compose.prod.yml`:

| Service   |      CPU limit | RAM limit |
| --------- | -------------: | --------: |
| Backend   |            1.5 |    768 MB |
| OSRM      | 1.5, 2 threads |      2 GB |
| Redis     |           0.25 |    192 MB |
| Mosquitto |           0.25 |     96 MB |

Dokploy, Traefik, Docker, Rocky Linux, and filesystem cache use the remaining resources. OSRM preparation is exceptional: it may use up to 4 CPUs, 5 GB RAM, and swap, but it runs only when creating/updating the map graph.

## 1. Prepare DNS and accounts

Create these DNS records before deployment:

```text
api.example.com      A/AAAA  -> VPS
panel.example.com    A/AAAA  -> VPS
app.example.com      CNAME   -> Vercel target
```

Create or have access to:

- GitHub repository for `DashlyBackend`.
- GitHub Container Registry (GHCR), enabled automatically by the workflow.
- Supabase project.
- Vercel project for `DashlyDashboard`.
- Rocky Linux root SSH access.

Use a private backend repository if desired. Its GHCR package will also be private initially; Dokploy then needs GHCR credentials.

## 2. Secure a fresh Rocky Linux server

Log in as root:

```bash
ssh root@VPS_IP
```

Create a non-root administrator before disabling password/root access:

```bash
useradd -m -G wheel deploy
passwd deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

Test a second SSH session as `deploy` before continuing.

Clone the backend temporarily to run the checked-in bootstrap:

```bash
dnf install -y git
mkdir -p /opt/dashly
cd /opt/dashly
git clone https://github.com/Fikuraru72/DashlyBackend.git
cd DashlyBackend
chmod +x scripts/*.sh
sudo scripts/prod-bootstrap.sh
```

The bootstrap:

- Updates Rocky packages.
- Installs basic tools and enables `firewalld`.
- Opens SSH, HTTP, HTTPS, and temporary Dokploy port `3000`.
- Creates 8 GB swap if no swap exists. This protects the 6 GB VPS during OSRM preparation/build spikes.
- Keeps SELinux enabled.

Optional SSH hardening after key login is proven:

```bash
cat >/etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload sshd
```

## 3. Install Dokploy

Ensure ports are free:

```bash
ss -lntp | grep -E ':(80|443|3000)\b' || true
```

Install the latest stable Dokploy:

```bash
sudo scripts/dokploy-install.sh
```

The script downloads the official installer first and stops on HTTP failure. Equivalent official command:

```bash
curl -sSL https://dokploy.com/install.sh | DOKPLOY_VERSION=latest sh
```

Open:

```text
http://VPS_IP:3000
```

Create the first Dokploy administrator immediately.

### Configure the Dokploy panel domain

In Dokploy, configure `panel.example.com` with HTTPS. Verify:

```bash
curl -I https://panel.example.com
```

Only after HTTPS works, remove direct `IP:3000` access:

```bash
sudo scripts/dokploy-lockdown.sh
```

Do not install Caddy or Nginx: Dokploy already owns ports 80/443 through Traefik.

## 4. Configure Supabase

In Supabase **Connect**, copy:

1. **Session pooler URI**, suitable for the persistent NestJS server on an IPv4 VPS.
2. **Direct URI** if the VPS has IPv6 or Supabase dedicated IPv4. Direct connections are preferred for migrations/administrative work.

For this Compose setup, use the session pooler URI for `DATABASE_URL` unless direct connectivity is confirmed:

```env
DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:5432/postgres?sslmode=require
```

Do not use the browser/API keys as database credentials. URL-encode special characters in the database password.

Before first production deployment, test the duplicate-BIB migration against a production snapshot. Migration `0002_event_participant_bib_unique.sql` intentionally aborts if duplicates exist.

## 5. Build and publish the backend to GHCR

Workflow: `.github/workflows/backend-image.yml`.

Every pull request to `master` runs:

```text
vp install --frozen-lockfile
vp check
vp run build
vp test
```

Every push to `master` additionally builds and publishes:

```text
ghcr.io/<github-owner>/dashly-backend:latest
ghcr.io/<github-owner>/dashly-backend:sha-<commit>
```

Git tags such as `v1.0.0` also produce the matching image tag.

The workflow uses currently researched stable action releases rather than floating majors:

```text
actions/checkout@v7.0.0
voidzero-dev/setup-vp@v1.9.0
docker/setup-buildx-action@v4.2.0
docker/login-action@v4.4.0
docker/metadata-action@v6.2.0
docker/build-push-action@v7.3.0
```

Push once and verify under GitHub **Packages**:

```bash
git push origin master
```

If the repository/package is private, create a GitHub classic PAT with `read:packages` for Dokploy. The workflow itself publishes with `GITHUB_TOKEN`; no publishing PAT is required.

## 6. Prepare the Java bicycle OSRM graph

The Geofabrik Java extract is roughly 850 MB and changes daily. Preparation creates multiple graph files and needs substantial temporary disk/RAM. Keep at least 20 GB free before starting:

```bash
df -h /
free -h
```

Run once on the VPS:

```bash
cd /opt/dashly/DashlyBackend
sudo -u deploy scripts/osrm-prepare.sh
```

It will:

1. Pull official `ghcr.io/project-osrm/osrm-backend:v26.7.3-debian`.
2. Download `java-latest.osm.pbf` from Geofabrik with resume/retry.
3. Run `osrm-extract` using `/opt/bicycle.lua`.
4. Run MLD `osrm-partition` and `osrm-customize`.
5. Store the result in named volume `dashly-osrm-bicycle`.
6. Delete the downloaded PBF after success.

Verify:

```bash
docker volume inspect dashly-osrm-bicycle
docker run --rm -v dashly-osrm-bicycle:/data \
  ghcr.io/project-osrm/osrm-backend:v26.7.3-debian \
  test -f /data/java.osrm
```

To update map data later:

```bash
FORCE_OSRM_REBUILD=1 scripts/osrm-prepare.sh
```

Schedule this manually during a maintenance window. Do not rebuild the graph on every application deployment.

## 7. Create the Dokploy Compose deployment

In Dokploy:

1. Create project `Dashly`.
2. Create environment `Production`.
3. Add **Docker Compose** named `Dashly Backend`.
4. Source: GitHub repository `DashlyBackend`.
5. Branch: `master`.
6. Compose path: `docker-compose.prod.yml`.
7. Compose type: standard Docker Compose, not Stack.
8. Disable repository auto-deploy if GitHub Actions will trigger deployment after publishing the image. This avoids deploying before the GHCR image exists.

### Environment variables

Paste into Dokploy's Compose **Environment** tab:

```env
BACKEND_IMAGE=ghcr.io/fikuraru72/dashly-backend:latest
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:5432/postgres?sslmode=require
JWT_SECRET=GENERATE_A_LONG_RANDOM_SECRET
GOOGLE_CLIENT_ID=
REDIS_HOST=redis
REDIS_PORT=6379
MQTT_HOST=mosquitto
MQTT_PORT=1883
OSRM_ENABLED=true
OSRM_URL=http://osrm-bicycle:5000
OSRM_PROFILE=bicycle
```

Generate the JWT secret locally:

```bash
openssl rand -base64 48
```

Dokploy writes the environment to `.env`; the Compose file explicitly uses `env_file: .env` because Dokploy does not inject those values automatically.

### GHCR authentication for a private image

In Dokploy, add GHCR as a registry:

```text
Registry: ghcr.io
Username: GitHub username
Password/token: PAT with read:packages
```

Make the GHCR package public if private registry configuration is unnecessary and public distribution is acceptable.

### Persistent volumes

The Compose file uses named volumes:

```text
dashly-osrm-bicycle   OSRM Java graph
redis_data             Redis AOF
mosquitto.conf         Read-only Mosquitto config from the repository
mosquitto_data         Mosquitto persistence
mosquitto_log          Mosquitto logs
```

Never delete volumes during normal redeploys. Deleting `dashly-osrm-bicycle` requires preparing the graph again.

### Mosquitto config

Compose mounts the checked-in `mosquitto.conf` read-only. Anonymous MQTT is acceptable only while MQTT remains internal to the Compose network. The current production Compose does not publish port 1883. If participant devices must connect directly over the internet, do not expose anonymous 1883; configure authenticated MQTT over TLS on 8883 first.

### Backend domain

In Compose **Domains**, create:

```text
Host: api.example.com
Service: app
Container port: 3000
Path: /
HTTPS: enabled
Certificate: Let's Encrypt
```

Do not add `ports:` for the app. Dokploy/Traefik routes to the internal `3000` port.

Deploy. The startup sequence is:

1. Redis, Mosquitto, and OSRM become healthy.
2. One-shot `migrate` runs `drizzle-kit migrate` against Supabase.
3. Backend starts only if migration succeeds.
4. Traefik routes `api.example.com` to the healthy backend.

## 8. Connect GitHub Actions to Dokploy CD

After the first manual deployment:

1. Dokploy profile → API/CLI → generate API key.
2. Find the Compose ID from the Dokploy URL/API.
3. GitHub repository → Settings → Secrets and variables → Actions.
4. Add secret:

```text
DOKPLOY_API_KEY=<generated API key>
```

5. Add repository variables:

```text
DOKPLOY_URL=https://panel.example.com
DOKPLOY_COMPOSE_ID=<compose id>
```

On every successful `master` image publish, GitHub Actions calls:

```text
POST /api/compose.redeploy
```

Dokploy then pulls `BACKEND_IMAGE` and redeploys. If the variables are absent, CI still builds/publishes but skips deployment.

## 9. Deploy frontend to Vercel

Import `DashlyDashboard` into Vercel and select Next.js. Set production environment variables:

```env
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_BACKEND_URL=https://api.example.com
```

Add the frontend custom domain, for example `app.example.com`, then redeploy. Next.js `/api/auth/login`, `/api/auth/refresh`, and `/api/auth/logout` must remain server route handlers; do not configure the frontend as a static export.

Refresh tokens remain in an httpOnly cookie owned by the frontend origin. Browser requests to `/api/auth/refresh` are same-origin, so `SameSite=Lax` works even though the backend uses `api.example.com`.

## 10. Verification

### Backend

```bash
curl --fail https://api.example.com/health/sync
curl -i -X OPTIONS https://api.example.com/auth/login \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: POST'
```

Expected health response: HTTP 200 with database connectivity information.

### OSRM from the Compose network

Use Dokploy terminal on the `app` container or run from the deployment host with the project network:

```bash
curl 'http://osrm-bicycle:5000/route/v1/bicycle/106.827,-6.175;106.829,-6.177?overview=false'
```

Expected JSON contains `"code":"Ok"`.

### Containers and resources

```bash
docker ps
docker stats --no-stream
docker service ls
free -h
df -h
```

During normal runtime, OSRM should not consume 1.5 CPUs continuously. The CPU value is a ceiling, not reservation.

### End-to-end

Verify in order:

1. Open Vercel frontend.
2. Login.
3. Refresh the browser; session refresh succeeds.
4. Fetch dashboard events.
5. Connect Socket.IO.
6. Join an authorized event room.
7. Create/normalize a bicycle route inside Java.
8. Confirm Redis/MQTT consumers and live positions.

## 11. Operations

### Monitoring

Use Dokploy's built-in monitoring first; Grafana is unnecessary for the initial production deployment.

Open:

```text
Dokploy → Monitoring → Setup Monitoring
```

Recommended starting values:

```text
Server refresh:       30 seconds
Container refresh:    30 seconds
Retention:            7 days
CPU alert:            85%
Memory alert:         85%
Disk alert:           80%
```

Monitor at minimum:

- VPS CPU, RAM, swap, disk usage, network, and load average.
- `app` health, restart count, and RAM approaching its 768 MB limit.
- `osrm-bicycle` restarts and RAM approaching its 2 GB limit.
- `redis` restarts, memory usage, and `noeviction` errors.
- `mosquitto` repeated disconnects and broker errors.
- `/health/sync` availability.

Configure Dokploy notification channels and threshold alerts. Keep the collection interval at 30 seconds unless faster data is operationally necessary; shorter intervals add server load.

Add Grafana Cloud/Alloy later only when the built-in monitoring becomes insufficient—for example, application request latency p95/p99, endpoint error rates, BullMQ queue metrics, searchable centralized logs, business metrics, or longer retention.

### View logs

Use Dokploy's per-service Logs tab, or:

```bash
docker logs --tail 200 -f <container>
```

### Roll back backend

Use an immutable SHA tag published by CI:

```env
BACKEND_IMAGE=ghcr.io/fikuraru72/dashly-backend:sha-abcdef0
```

Save and redeploy in Dokploy. Avoid rolling back database migrations blindly; verify schema compatibility first.

### Update Dokploy

```bash
curl -sSL https://dokploy.com/install.sh | sh -s update
```

Read Dokploy release notes before updating production.

### Update OSRM

1. Pin the new official GHCR image in Compose and scripts.
2. Run repository checks.
3. Rebuild the graph with `FORCE_OSRM_REBUILD=1`.
4. Redeploy and smoke-test routing.

Graph files are version-sensitive; do not assume a graph generated by an older OSRM is compatible with a new binary.

### Backup

Supabase handles PostgreSQL according to the selected plan. Also back up:

- Dokploy configuration.
- Redis volume if losing queued/replay data is unacceptable.
- Mosquitto data if persistent sessions matter.

OSRM graph can be regenerated from Geofabrik and normally does not require backup.

## Security checklist

- [ ] SSH key authentication works.
- [ ] Password SSH login disabled.
- [ ] SELinux remains enforcing.
- [ ] Only ports 22, 80, and 443 are public after Dokploy setup.
- [ ] Dokploy direct port 3000 disabled after panel HTTPS works.
- [ ] Redis, OSRM, Mosquitto, and backend container ports are not host-published.
- [ ] `JWT_SECRET` is random and not committed.
- [ ] Supabase password is not committed.
- [ ] GHCR token has only `read:packages` on the VPS/Dokploy side.
- [ ] GitHub Actions publishing uses scoped `GITHUB_TOKEN`.
- [ ] MQTT remains internal or is upgraded to authenticated TLS before public exposure.
- [ ] Production migration tested on a database snapshot.

## Authoritative references

- Dokploy installation: <https://docs.dokploy.com/docs/core/installation>
- Dokploy Compose: <https://docs.dokploy.com/docs/core/docker-compose>
- Dokploy production guidance: <https://docs.dokploy.com/docs/core/applications/going-production>
- Dokploy Compose API: <https://docs.dokploy.com/docs/api/reference-compose>
- Dokploy monitoring: <https://docs.dokploy.com/docs/core/monitoring>
- Docker on RHEL: <https://docs.docker.com/engine/install/rhel/>
- Supabase connections: <https://supabase.com/docs/guides/database/connecting-to-postgres>
- OSRM releases/images: <https://github.com/Project-OSRM/osrm-backend/releases>
- Java OSM extract: <https://download.geofabrik.de/asia/indonesia/java.html>
- Vercel environment variables: <https://vercel.com/docs/environment-variables>
