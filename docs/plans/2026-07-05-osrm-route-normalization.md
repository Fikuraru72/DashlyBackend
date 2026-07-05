# OSRM Route Normalization Implementation Plan

> **IMPORTANT**: Use plan-execute skill to implement this plan task-by-task.

**Goal:** Make event fixed routes follow real roads/paths for cycling and running using self-hosted OSRM.
**Architecture:** Add OSRM services to Docker Compose, one preprocessed graph per routing profile: bicycle and foot. NestJS normalizes uploaded/provided `routeGeojson` through OSRM before saving/returning it; raw GPS tracking stays unchanged.
**Tech Stack:** NestJS, Docker Compose, `osrm/osrm-backend`, OSRM `/route` API, Drizzle existing `events.routeGeojson` JSONB.

---

## Research Notes

- OSRM is profile-based. One preprocessed graph = one profile. Bicycle and running need separate OSRM data dirs/services.
- Use OSRM `bicycle.lua` for cycling, `foot.lua` for running.
- OSRM `/route/v1/{profile}/{lon,lat;lon,lat}` returns road/path-following route. Use `geometries=geojson&overview=full&steps=false`.
- OSRM `/match` is for noisy participant GPS trails. Not needed for fixed event route first.
- Public demo server not production. Self-host via `osrm/osrm-backend`.
- Preprocess flow for MLD: `osrm-extract` → `osrm-partition` → `osrm-customize` → `osrm-routed --algorithm mld`.
- Dockerfile not required unless we customize profiles. Mount official profiles or copied profile files. Simpler: no Dockerfile.

---

## Decisions

- Use existing `routeGeojson` column. No DB migration.
- Add OSRM env vars:
  - `OSRM_ENABLED=true`
  - `OSRM_BICYCLE_URL=http://localhost:5000`
  - `OSRM_FOOT_URL=http://localhost:5001`
  - `OSRM_PBF_URL=https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf`
- For event `category === CYCLING`, use bicycle OSRM.
- For event `category === RUNNING`, use foot OSRM.
- If OSRM fails, return/save original raw route. App must still work offline.
- Use Node built-in `fetch`; no new dependency.

---

## Implementation Tasks

### 1. Add environment config

Edit `.env.example` and current `.env`:

```env
OSRM_ENABLED=true
OSRM_BICYCLE_URL=http://localhost:5000
OSRM_FOOT_URL=http://localhost:5001
OSRM_PBF_URL=https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf
```

### 2. Add OSRM data prep script

Create `scripts/osrm-prepare.sh`.

Behavior:
1. create `osrm-data/bicycle` and `osrm-data/foot`
2. download `${OSRM_PBF_URL}` to `osrm-data/map.osm.pbf` if missing
3. include script comments for data scale:
   - MVP Java/East Java-ish: `https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf`
   - full Indonesia later: `https://download.geofabrik.de/asia/indonesia-latest.osm.pbf`
4. run:
   - `osrm-extract -p /opt/bicycle.lua /data/map.osm.pbf`
   - `osrm-partition /data/map.osrm`
   - `osrm-customize /data/map.osrm`
5. repeat for `/opt/foot.lua`

Use `docker run --rm -v "$PWD/osrm-data/...:/data" osrm/osrm-backend ...` inside script. Simpler than fragile Compose one-shot dependencies.

### 3. Update Docker Compose

Add services:

```yaml
  osrm-bicycle:
    image: osrm/osrm-backend:latest
    container_name: dashly_osrm_bicycle
    command: osrm-routed --algorithm mld /data/map.osrm
    ports:
      - "5000:5000"
    volumes:
      - ./osrm-data/bicycle:/data
    networks:
      - dashly-network

  osrm-foot:
    image: osrm/osrm-backend:latest
    container_name: dashly_osrm_foot
    command: osrm-routed --algorithm mld /data/map.osrm
    ports:
      - "5001:5000"
    volumes:
      - ./osrm-data/foot:/data
    networks:
      - dashly-network
```

### 4. Add OSRM Nest service

Create `src/modules/events/osrm.service.ts`.

Methods:
- `normalizeRoute(category: 'RUNNING' | 'CYCLING', geojson: unknown): Promise<NormalizedRoute>`
- extract `LineString` coordinates from `Feature`, `FeatureCollection`, or raw `LineString`
- call OSRM `/route`
- return GeoJSON `Feature<LineString>` plus distance meters
- fallback to input route on any error

API URL shape:

```txt
{baseUrl}/route/v1/{profile}/{lon,lat;lon,lat}?overview=full&geometries=geojson&steps=false
```

Profile path segment can be `bike`/`foot` or anything; self-hosted OSRM ignores it mostly, graph decides behavior.

### 5. Wire service

Edit `src/modules/events/events.module.ts`:
- add `OsrmService` provider

Edit `src/modules/events/events.controller.ts`:
- inject `OsrmService`
- in `uploadGpx`, normalize parsed GPX before returning

Response stays same shape:

```ts
return { success: true, data: normalizedParsed };
```

### 6. Normalize direct create/update too

Edit `EventsService`:
- inject `OsrmService`
- before insert, if `dto.routeGeojson`, normalize based on category
- before update, if `dto.routeGeojson`, normalize based on new category or existing event category

This covers clients that skip `/events/upload-gpx` and send route directly.

### 7. Add ignore rules

Add to `.gitignore`:

```gitignore
osrm-data/
```

### 8. Add scripts

Update `package.json` scripts:

```json
"osrm:prepare": "bash scripts/osrm-prepare.sh",
"osrm:up": "docker compose up -d osrm-bicycle osrm-foot"
```

Run with `vp run osrm:prepare`, `vp run osrm:up`.

### 9. Checks

Run:

```bash
vp run build
vp run osrm:prepare
vp run osrm:up
docker compose up -d
curl http://localhost:5000/route/v1/bike/106.8227,-6.1744;106.8287,-6.1804?overview=full\&geometries=geojson
curl http://localhost:5001/route/v1/foot/106.8227,-6.1744;106.8287,-6.1804?overview=full\&geometries=geojson
```

Then upload GPX and confirm returned route has many road-following coordinates.

---

## Risks / Limits

- Java OSM extract is smaller for MVP. Full Indonesia later will take more time and disk.
- OSRM route may choose a valid road route different from official race route if waypoints are too sparse.
- Best official route quality still needs enough checkpoints.
- Running uses OSRM foot profile, not custom “race running” profile. Tune later only if routes look wrong.

---

## Future, Not Now

- OSRM `/match` for participant trails.
- Cache normalized route by hash.
- Custom bicycle profile tuned for safety vs speed.
- Admin UI toggle: raw route vs OSRM normalized route.
