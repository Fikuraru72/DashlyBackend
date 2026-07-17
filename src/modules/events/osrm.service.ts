import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Feature, LineString, Position } from 'geojson';

type EventCategory = 'RUNNING' | 'CYCLING';
type UnknownRecord = Record<string, unknown>;

export interface NormalizedRoute {
  geoJson: Feature<LineString>;
  totalDistanceMeters: number;
}

@Injectable()
export class OsrmService {
  private readonly logger = new Logger(OsrmService.name);
  private readonly maxWaypoints = 100;

  constructor(private readonly configService: ConfigService) {}

  async normalizeRoute(category: EventCategory, geojson: unknown): Promise<NormalizedRoute | null> {
    const rawRoute = this.extractLineString(geojson);
    if (!rawRoute) return null;

    const fallback = {
      geoJson: rawRoute,
      totalDistanceMeters: Math.round(this.calculateDistance(rawRoute.geometry.coordinates)),
    };

    if (
      this.configService.get('OSRM_ENABLED', 'true') === 'false' ||
      rawRoute.properties?.source === 'gpx'
    ) {
      return fallback;
    }

    try {
      const coordinates = this.limitWaypoints(rawRoute.geometry.coordinates);
      const coordinatePath = coordinates.map(([lng, lat]) => `${lng},${lat}`).join(';');
      const profile = this.getProfile(category);
      const url = `${this.getBaseUrl()}/route/v1/${profile}/${coordinatePath}?overview=full&geometries=geojson&steps=false`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, {
        headers: { 'User-Agent': 'dashly-backend/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`OSRM ${response.status}: ${await response.text()}`);
      }

      const body = (await response.json()) as {
        routes?: Array<{
          distance?: number;
          geometry?: LineString;
        }>;
      };
      const route = body.routes?.[0];
      if (!route?.geometry?.coordinates?.length) return fallback;

      return {
        geoJson: {
          type: 'Feature',
          properties: { source: 'osrm', profile },
          geometry: route.geometry,
        },
        totalDistanceMeters: Math.round(
          route.distance ?? this.calculateDistance(route.geometry.coordinates),
        ),
      };
    } catch (error) {
      this.logger.warn(
        `OSRM route normalization failed, using raw route: ${(error as Error).message}`,
      );
      return fallback;
    }
  }

  private getBaseUrl(): string {
    return this.configService
      .get<string>('OSRM_URL', 'https://router.project-osrm.org')
      .replace(/\/$/, '');
  }

  /**
   * Match a trajectory (array of raw GPS points) to the road network.
   * Uses OSRM Match API (/match/v1) which applies Hidden Markov Model
   * to find the most likely road path. Returns the snapped coordinate
   * for the LAST point in the trajectory (i.e. the current position).
   *
   * Requires at least 2 points to form a trajectory.
   * Returns null on failure (caller should fall back to geometric snap).
   */
  async matchTrajectory(
    points: { lng: number; lat: number; timestamp: number }[],
  ): Promise<{ lat: number; lng: number } | null> {
    if (points.length < 2) return null;

    if (this.configService.get('OSRM_ENABLED', 'true') === 'false') {
      return null;
    }

    try {
      const coordinatePath = points.map((p) => `${p.lng},${p.lat}`).join(';');

      // Timestamps help OSRM weight the HMM transitions by speed
      const timestamps = points.map((p) => Math.round(p.timestamp / 1000));
      const timestampParam = timestamps.join(';');

      // radiuses: per-point GPS accuracy tolerance in meters (15m is reasonable for smartphones)
      const radiuses = points.map(() => '15').join(';');

      const profile = this.configService.get<string>('OSRM_PROFILE', 'bike');
      const url =
        `${this.getBaseUrl()}/match/v1/${profile}/${coordinatePath}` +
        `?overview=false&geometries=geojson&timestamps=${timestampParam}&radiuses=${radiuses}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000); // 2s timeout (tight for live tracking)

      const response = await fetch(url, {
        headers: { 'User-Agent': 'dashly-backend/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn(`OSRM Match API ${response.status}`);
        return null;
      }

      const body = (await response.json()) as {
        matchings?: Array<{ geometry?: { coordinates?: number[][] } }>;
        tracepoints?: Array<{ location?: [number, number] } | null>;
      };

      // Use the tracepoint for the LAST input point — this is the snapped current position
      const tracepoints = body.tracepoints;
      if (!tracepoints || tracepoints.length === 0) return null;

      // Find the last non-null tracepoint (OSRM may null-out unmatched points)
      for (let i = tracepoints.length - 1; i >= 0; i--) {
        const tp = tracepoints[i];
        if (tp?.location) {
          return { lng: tp.location[0], lat: tp.location[1] };
        }
      }

      return null;
    } catch (error) {
      this.logger.debug(`OSRM Match failed (non-fatal): ${(error as Error).message}`);
      return null;
    }
  }

  private getProfile(_category: EventCategory): string {
    return this.configService.get<string>('OSRM_PROFILE', 'bike');
  }

  private extractLineString(geojson: unknown): Feature<LineString> | null {
    const value = typeof geojson === 'string' ? this.safeParse(geojson) : geojson;
    if (!this.isRecord(value)) return null;

    if (value.type === 'Feature' && this.isRecord(value.geometry)) {
      return this.toLineStringFeature(value, value.geometry);
    }

    if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
      for (const feature of value.features) {
        if (!this.isRecord(feature) || !this.isRecord(feature.geometry)) {
          continue;
        }
        const lineString = this.toLineStringFeature(feature, feature.geometry);
        if (lineString) return lineString;
      }
      return null;
    }

    if (value.type === 'LineString') {
      const geometry = this.toLineString(value);
      return geometry ? { type: 'Feature', properties: {}, geometry } : null;
    }

    return null;
  }

  private isRecord(value: unknown): value is UnknownRecord {
    return Boolean(value) && typeof value === 'object';
  }

  private toLineStringFeature(
    feature: UnknownRecord,
    geometryValue: UnknownRecord,
  ): Feature<LineString> | null {
    const geometry = this.toLineString(geometryValue);
    if (!geometry) return null;

    return {
      type: 'Feature',
      properties: this.isRecord(feature.properties) ? feature.properties : {},
      geometry,
    };
  }

  private toLineString(value: UnknownRecord): LineString | null {
    if (value.type !== 'LineString' || !Array.isArray(value.coordinates)) {
      return null;
    }

    const coordinates = value.coordinates.filter(
      (coordinate): coordinate is Position =>
        Array.isArray(coordinate) &&
        typeof coordinate[0] === 'number' &&
        typeof coordinate[1] === 'number',
    );

    return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
  }

  private safeParse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private limitWaypoints(coordinates: Position[]): Position[] {
    if (coordinates.length <= this.maxWaypoints) return coordinates;

    const step = (coordinates.length - 1) / (this.maxWaypoints - 1);
    return Array.from(
      { length: this.maxWaypoints },
      (_, index) => coordinates[Math.round(index * step)],
    );
  }

  private calculateDistance(coordinates: Position[]): number {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
      total += this.haversine(coordinates[i - 1], coordinates[i]);
    }
    return total;
  }

  private haversine(from: Position, to: Position): number {
    const radius = 6371e3;
    const lat1 = (from[1] * Math.PI) / 180;
    const lat2 = (to[1] * Math.PI) / 180;
    const deltaLat = ((to[1] - from[1]) * Math.PI) / 180;
    const deltaLon = ((to[0] - from[0]) * Math.PI) / 180;
    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
    return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
