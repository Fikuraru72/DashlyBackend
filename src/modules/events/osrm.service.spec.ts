import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OsrmService } from './osrm.service';

function service(region: 'java' | 'east-java') {
  return new OsrmService({
    get: vi.fn((key: string, fallback?: unknown) =>
      key === 'OSRM_REGION' ? region : key === 'OSRM_ENABLED' ? 'false' : fallback,
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
});
