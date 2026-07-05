import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { OsrmService } from '../src/modules/events/osrm.service';

@Controller('test-osrm')
class TestOsrmController {
  constructor(private readonly osrmService: OsrmService) {}

  @Get('route')
  async route() {
    return this.osrmService.normalizeRoute('CYCLING', {
      type: 'LineString',
      coordinates: [
        [106.8227, -6.1744],
        [106.8287, -6.1804],
      ],
    });
  }
}

describe('OSRM route normalization (e2e)', () => {
  let app: INestApplication;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it('returns OSRM matched geometry through HTTP', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        routes: [
          {
            distance: 2500,
            geometry: {
              type: 'LineString',
              coordinates: [
                [106.8227, -6.1744],
                [106.824, -6.176],
                [106.8287, -6.1804],
              ],
            },
          },
        ],
      }),
    } as Response);

    const moduleRef = await Test.createTestingModule({
      controllers: [TestOsrmController],
      providers: [
        OsrmService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            OSRM_ENABLED: 'true',
            OSRM_BICYCLE_URL: 'http://osrm-bike:5000',
          }),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get('/test-osrm/route')
      .expect(200)
      .expect(({ body }) => {
        expect(body.totalDistanceMeters).toBe(2500);
        expect(body.geoJson.properties.source).toBe('osrm');
        expect(body.geoJson.geometry.coordinates).toHaveLength(3);
      });
  });

  it('falls back through HTTP when OSRM is unavailable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));

    const moduleRef = await Test.createTestingModule({
      controllers: [TestOsrmController],
      providers: [
        OsrmService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            OSRM_ENABLED: 'true',
            OSRM_BICYCLE_URL: 'http://osrm-bike:5000',
          }),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get('/test-osrm/route')
      .expect(200)
      .expect(({ body }) => {
        expect(body.geoJson.properties).toEqual({});
        expect(body.geoJson.geometry.coordinates).toHaveLength(2);
      });
  });
});
