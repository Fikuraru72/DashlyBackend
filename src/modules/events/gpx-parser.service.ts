import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { DOMParser } from '@xmldom/xmldom';
import { gpx } from '@tmcw/togeojson';
import { LineString, Feature } from 'geojson';
import { RoutePreprocessorService } from './route-preprocessor.service';

export interface ParsedGpxResult {
  geoJson: Feature<LineString>;
  totalDistanceMeters: number;
  totalElevationMeters: number;
  startPoint: { lat: number; lng: number } | null;
  finishPoint: { lat: number; lng: number } | null;
  altitudeProfile?: Array<{
    distance: number;
    elevation: number;
    lat: number;
    lng: number;
    cumGain: number;
    cumLoss: number;
  }>;
}

@Injectable()
export class GpxParserService {
  private readonly logger = new Logger(GpxParserService.name);

  constructor(private readonly routePreprocessor: RoutePreprocessorService) {}

  parseGpx(gpxString: string): ParsedGpxResult {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(gpxString, 'text/xml');

      // Check for parsing errors
      const errors = doc.getElementsByTagName('parsererror');
      if (errors.length > 0) {
        throw new BadRequestException('Invalid GPX XML format');
      }

      const geoJson = gpx(doc);

      // Find the first LineString or MultiLineString
      let routeFeature = geoJson.features.find(
        (f) => f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString',
      ) as Feature<LineString>;

      if (!routeFeature) {
        throw new BadRequestException('No route (LineString) found in GPX file');
      }

      // If it's a MultiLineString, we flatten it to a single LineString for simplicity
      if ((routeFeature.geometry.type as any) === 'MultiLineString') {
        const coords = (routeFeature.geometry as any).coordinates.flat(1);
        routeFeature = {
          ...routeFeature,
          geometry: {
            type: 'LineString',
            coordinates: coords,
          },
        };
      }

      const rawCoordinates = routeFeature.geometry.coordinates;
      if (!rawCoordinates || rawCoordinates.length < 2) {
        throw new BadRequestException('GPX route does not contain enough coordinates');
      }

      // ── Apply Normalization + Densification Pipeline ───────────
      const { coordinates: processedTriples } = this.routePreprocessor.preprocessRoute(
        rawCoordinates,
        { targetSpacing: 15, adaptiveDensification: true },
      );

      // Update geometry coordinates with cleaned + densified triples [lng, lat, ele] and mark source as 'gpx'
      routeFeature = {
        ...routeFeature,
        properties: {
          ...routeFeature.properties,
          source: 'gpx',
        },
        geometry: {
          type: 'LineString',
          coordinates: processedTriples,
        },
      };

      let totalDistance = 0;
      let totalElevation = 0;
      let cumGain = 0;
      let cumLoss = 0;

      const altitudeProfile: any[] = [];

      if (processedTriples.length > 0) {
        altitudeProfile.push({
          distance: 0,
          elevation: processedTriples[0][2],
          lat: processedTriples[0][1],
          lng: processedTriples[0][0],
          cumGain: 0,
          cumLoss: 0,
        });
      }

      for (let i = 1; i < processedTriples.length; i++) {
        const prev = processedTriples[i - 1];
        const curr = processedTriples[i];

        const d = this.calculateHaversineDistance(prev[1], prev[0], curr[1], curr[0]);
        totalDistance += d;

        const eleDiff = curr[2] - prev[2];
        if (eleDiff > 0) {
          totalElevation += eleDiff;
          cumGain += eleDiff;
        } else {
          cumLoss += Math.abs(eleDiff);
        }

        altitudeProfile.push({
          distance: Math.round(totalDistance),
          elevation: curr[2],
          lat: curr[1],
          lng: curr[0],
          cumGain: Math.round(cumGain),
          cumLoss: Math.round(cumLoss),
        });
      }

      const startPoint = { lat: processedTriples[0][1], lng: processedTriples[0][0] };
      const lastCoord = processedTriples[processedTriples.length - 1];
      const finishPoint = { lat: lastCoord[1], lng: lastCoord[0] };

      return {
        geoJson: routeFeature,
        totalDistanceMeters: Math.round(totalDistance),
        totalElevationMeters: Math.round(totalElevation),
        startPoint,
        finishPoint,
        altitudeProfile,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Failed to parse GPX file: ' + error.message);
    }
  }

  private calculateHaversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371e3;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
