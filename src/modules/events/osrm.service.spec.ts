import { ConfigService } from '@nestjs/config';
import { OsrmService } from './osrm.service';

describe('OsrmService', () => {
  const rawRoute = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [106.8227, -6.1744],
        [106.8287, -6.1804],
      ],
    },
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes route with OSRM geometry', async () => {
    const service = new OsrmService(
      new ConfigService({
        OSRM_ENABLED: 'true',
        OSRM_BICYCLE_URL: 'http://osrm-bike:5000',
      }),
    );
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        routes: [
          {
            distance: 1234.4,
            geometry: {
              type: 'LineString',
              coordinates: [
                [106.8227, -6.1744],
                [106.825, -6.176],
                [106.8287, -6.1804],
              ],
            },
          },
        ],
      }),
    } as Response);

    const result = await service.normalizeRoute('CYCLING', rawRoute);

    expect(result?.totalDistanceMeters).toBe(1234);
    expect(result?.geoJson.properties).toEqual({ source: 'osrm', profile: 'bike' });
    expect(result?.geoJson.geometry.coordinates).toHaveLength(3);
    expect(fetch).toHaveBeenCalledWith(
      'http://osrm-bike:5000/route/v1/bike/106.8227,-6.1744;106.8287,-6.1804?overview=full&geometries=geojson&steps=false',
    );
  });

  it('falls back to raw route when OSRM fails', async () => {
    const service = new OsrmService(
      new ConfigService({
        OSRM_ENABLED: 'true',
        OSRM_BICYCLE_URL: 'http://osrm-bike:5000',
      }),
    );
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'broken',
    } as Response);

    const result = await service.normalizeRoute('RUNNING', rawRoute);

    expect(fetch).toHaveBeenCalledWith(
      'http://osrm-bike:5000/route/v1/bike/106.8227,-6.1744;106.8287,-6.1804?overview=full&geometries=geojson&steps=false',
    );
    expect(result?.geoJson).toEqual(rawRoute);
    expect(result?.totalDistanceMeters).toBeGreaterThan(0);
  });

  it('returns null for invalid route input', async () => {
    const service = new OsrmService(new ConfigService({ OSRM_ENABLED: 'false' }));

    await expect(service.normalizeRoute('RUNNING', { nope: true })).resolves.toBeNull();
  });
});
