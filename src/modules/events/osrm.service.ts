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

  async normalizeRoute(
    category: EventCategory,
    geojson: unknown,
  ): Promise<NormalizedRoute | null> {
    const rawRoute = this.extractLineString(geojson);
    if (!rawRoute) return null;

    const fallback = {
      geoJson: rawRoute,
      totalDistanceMeters: Math.round(
        this.calculateDistance(rawRoute.geometry.coordinates),
      ),
    };

    if (this.configService.get('OSRM_ENABLED', 'true') === 'false') {
      return fallback;
    }

    const baseUrl = this.getBaseUrl(category);
    if (!baseUrl) return fallback;

    try {
      const coordinates = this.limitWaypoints(rawRoute.geometry.coordinates);
      const coordinatePath = coordinates
        .map(([lng, lat]) => `${lng},${lat}`)
        .join(';');
      const profile = 'bike';
      const url = `${baseUrl}/route/v1/${profile}/${coordinatePath}?overview=full&geometries=geojson&steps=false`;

      const response = await fetch(url);
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

  private getBaseUrl(_category: EventCategory): string | null {
    const url = this.configService.get<string>('OSRM_BICYCLE_URL');
    return url ? url.replace(/\/$/, '') : null;
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

    return coordinates.length >= 2
      ? { type: 'LineString', coordinates }
      : null;
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

    const result: Position[] = [];
    const lastIndex = coordinates.length - 1;
    for (let i = 0; i < this.maxWaypoints; i++) {
      const index = Math.round((i * lastIndex) / (this.maxWaypoints - 1));
      result.push(coordinates[index]);
    }
    return result;
  }

  private calculateDistance(coordinates: Position[]): number {
    let total = 0;
    for (let i = 1; i < coordinates.length; i++) {
      const [prevLng, prevLat] = coordinates[i - 1];
      const [lng, lat] = coordinates[i];
      total += this.haversine(prevLat, prevLng, lat, lng);
    }
    return total;
  }

  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const radius = 6371e3;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
