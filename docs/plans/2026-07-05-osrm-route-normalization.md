# OSRM Route Normalization Implementation Plan

**Goal:** Make fixed event routes follow real roads/paths using one self-hosted OSRM bicycle graph. Cycling and running both use the same graph; participant speed/category stays dynamic in app logic.

## Decisions

- Use existing `routeGeojson` column. No DB migration.
- Run one OSRM service only: `osrm-bicycle`.
- Use East Java extract for MVP: `https://geo2day.com/asia/indonesia/east_java.pbf`.
- Use bicycle profile for all event categories to fit 2 CPU / 2GB RAM.
- If OSRM fails, return/save original raw route. App must still work offline.
- Use Node built-in `fetch`; no new dependency.

## Runtime config

```env
OSRM_ENABLED=true
OSRM_BICYCLE_URL=http://localhost:5000
OSRM_PBF_URL=https://geo2day.com/asia/indonesia/east_java.pbf
```

## Commands

```bash
vp run osrm:prepare
vp run osrm:up
curl 'http://localhost:5000/route/v1/bike/112.7521,-7.2575;112.6326,-7.9666?overview=full&geometries=geojson'
```

## Production note

Do not preprocess OSRM on the 2GB VPS if it OOMs. Preprocess on laptop/bigger temp VM, then upload `osrm-data/bicycle/` to the server. Runtime only needs `osrm-routed`.

## Future, not now

- Full Indonesia extract.
- Separate running profile/service if server memory is upgraded.
- OSRM `/match` for participant trails.
- Cache normalized route by hash.
