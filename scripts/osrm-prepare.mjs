#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const osrmImage = process.env.OSRM_IMAGE ?? 'osrm/osrm-backend:latest';
const pbfUrl = process.env.OSRM_PBF_URL ?? 'https://geo2day.com/asia/indonesia/east_java.pbf';
const dataDir = resolve(rootDir, 'osrm-data');
const profileDir = resolve(rootDir, 'osrm-profiles');
const pbfPath = resolve(dataDir, 'map.osm.pbf');

// MVP map: East Java extract, small enough for 2 CPU / 2GB RAM.
// Later when app is ready for wider deployment, switch to full Indonesia:
// OSRM_PBF_URL=https://download.geofabrik.de/asia/indonesia-latest.osm.pbf

mkdirSync(dataDir, { recursive: true });

async function download() {
  if (existsSync(pbfPath)) return;

  console.log(`Downloading OSM extract: ${pbfUrl}`);
  const res = await fetch(pbfUrl);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  await pipeline(Readable.fromWeb(res.body), createWriteStream(pbfPath));
}

function runDocker(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker exited with ${result.status}`);
}

function prepareProfile(name, profile) {
  const target = resolve(dataDir, name);

  console.log(`Preparing OSRM ${name} graph...`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  copyFileSync(pbfPath, resolve(target, 'map.osm.pbf'));

  runDocker([
    'run', '--rm', '-t',
    '--mount', `type=bind,source=${target},target=/data`,
    '--mount', `type=bind,source=${profileDir},target=/profiles,readonly`,
    osrmImage,
    'osrm-extract', '-p', `/profiles/${profile}.lua`, '/data/map.osm.pbf',
  ]);

  runDocker([
    'run', '--rm', '-t',
    '--mount', `type=bind,source=${target},target=/data`,
    osrmImage,
    'osrm-partition', '/data/map.osrm',
  ]);

  runDocker([
    'run', '--rm', '-t',
    '--mount', `type=bind,source=${target},target=/data`,
    osrmImage,
    'osrm-customize', '/data/map.osrm',
  ]);

  rmSync(resolve(target, 'map.osm.pbf'), { force: true });
}

await download();
prepareProfile('bicycle', 'bicycle');

console.log('OSRM data ready. Run: docker compose up -d osrm-bicycle');
