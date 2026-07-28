import { describe, it, expect, beforeEach } from 'vitest';
import { RoutePreprocessorService } from './route-preprocessor.service';

describe('RoutePreprocessorService', () => {
  let service: RoutePreprocessorService;

  beforeEach(() => {
    service = new RoutePreprocessorService();
  });

  it('should filter out invalid coordinates', () => {
    const rawCoords = [
      [112.7, -7.2, 10],
      [NaN, -7.2, 10],
      [112.7, 100, 10], // invalid latitude > 90
      [112.71, -7.21, 15],
    ];

    const result = service.preprocessRoute(rawCoords, {
      targetSpacing: 100000, // disable densification for test
      adaptiveDensification: false,
    });

    expect(result.stats.removedInvalid).toBe(2);
    expect(result.coordinates.length).toBe(2);
    expect(result.coordinates[0]).toEqual([112.7, -7.2, 10]);
    expect(result.coordinates[1]).toEqual([112.71, -7.21, 15]);
  });

  it('should remove duplicate consecutive points within threshold', () => {
    const rawCoords = [
      [112.7, -7.2, 10],
      [112.7, -7.2, 10], // exact duplicate
      [112.7, -7.2, 10.000001], // duplicate (< 0.5m)
      [112.71, -7.21, 15],
    ];

    const result = service.preprocessRoute(rawCoords, {
      targetSpacing: 100000,
      adaptiveDensification: false,
    });

    expect(result.stats.removedDuplicates).toBeGreaterThanOrEqual(1);
  });

  it('should correct invalid elevations via neighbor interpolation', () => {
    const rawCoords = [
      [112.7, -7.2, 100],
      [112.701, -7.201, -999], // invalid elevation < -500
      [112.702, -7.202, 120],
    ];

    const result = service.preprocessRoute(rawCoords, {
      targetSpacing: 100000,
      adaptiveDensification: false,
    });

    expect(result.stats.elevationsCorrected).toBe(1);
    expect(result.coordinates[1][2]).toBe(110); // average of 100 and 120
  });

  it('should smooth single-point elevation spikes using 3-point median filter', () => {
    const rawCoords = [
      [112.7, -7.2, 50],
      [112.7001, -7.2001, 500], // extreme spike (+450m over ~15m distance)
      [112.7002, -7.2002, 52],
    ];

    const result = service.preprocessRoute(rawCoords, {
      targetSpacing: 100000,
      adaptiveDensification: false,
      maxGradePercent: 100,
    });

    expect(result.stats.elevationSpikesSmoothed).toBe(1);
    expect(result.coordinates[1][2]).toBe(52); // median of [50, 500, 52] = 52
  });

  it('should densify segments longer than targetSpacing', () => {
    const rawCoords = [
      [112.7, -7.2, 10],
      [112.71, -7.21, 20], // ~1.5 km segment
    ];

    const result = service.preprocessRoute(rawCoords, {
      targetSpacing: 15, // 15m spacing
      adaptiveDensification: false,
    });

    expect(result.stats.pointsDensified).toBeGreaterThan(50);
    expect(result.coordinates.length).toBeGreaterThan(50);
  });
});
