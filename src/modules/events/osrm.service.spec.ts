import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OsrmService } from './osrm.service';

function service(region: 'java' | 'east-java', osrmEnabled = false) {
  return new OsrmService({
    get: vi.fn((key: string, fallback?: unknown) =>
      key === 'OSRM_REGION' ? region : key === 'OSRM_ENABLED' ? String(osrmEnabled) : fallback,
    ),
  } as never);
}

const route = (coordinates: number[][]) => ({
  type: 'Feature',
  properties: { source: 'gpx' },
  geometry: { type: 'LineString', coordinates },
});

describe('OsrmService region validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts East Java routes when configured for East Java', async () => {
    await expect(
      service('east-java').normalizeRoute(
        'CYCLING',
        route([
          [112.7508, -7.2575],
          [112.7525, -7.259],
        ]),
      ),
    ).resolves.not.toBeNull();
  });

  it('rejects Jakarta when configured for East Java', async () => {
    await expect(
      service('east-java').normalizeRoute(
        'CYCLING',
        route([
          [106.827, -6.175],
          [106.829, -6.177],
        ]),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts Jakarta when configured for Java', async () => {
    await expect(
      service('java').normalizeRoute(
        'CYCLING',
        route([
          [106.827, -6.175],
          [106.829, -6.177],
        ]),
      ),
    ).resolves.not.toBeNull();
  });

  it('matches an ordered trajectory and returns the latest snapped road coordinate', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        matchings: [{ confidence: 0.95 }],
        tracepoints: [
          { location: [112.7509, -7.2574], distance: 4 },
          { location: [112.7519, -7.2584], distance: 3 },
        ],
      }),
    } as never);

    await expect(
      service('east-java', true).matchTrajectory([
        { lng: 112.7518, lat: -7.2583, timestamp: 2_000 },
        { lng: 112.7508, lat: -7.2575, timestamp: 1_000 },
      ]),
    ).resolves.toEqual({ lng: 112.7519, lat: -7.2584 });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '/match/v1/bike/112.7508,-7.2575;112.7518,-7.2583?overview=false&geometries=geojson&timestamps=1;2&radiuses=15;15&tidy=true',
      ),
      expect.any(Object),
    );
  });

  it('rejects ambiguous road matches', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        matchings: [{ confidence: 0.1 }],
        tracepoints: [
          { location: [112.7509, -7.2574], distance: 4 },
          { location: [112.7519, -7.2584], distance: 3 },
        ],
      }),
    } as never);

    await expect(
      service('east-java', true).matchTrajectory([
        { lng: 112.7508, lat: -7.2575, timestamp: 1_000 },
        { lng: 112.7518, lat: -7.2583, timestamp: 2_000 },
      ]),
    ).resolves.toBeNull();
  });

  it('ignores duplicate timestamp seconds before matching', async () => {
    const result = await service('east-java', true).matchTrajectory([
      { lng: 112.7508, lat: -7.2575, timestamp: 1_100 },
      { lng: 112.7509, lat: -7.2576, timestamp: 1_400 },
    ]);

    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
