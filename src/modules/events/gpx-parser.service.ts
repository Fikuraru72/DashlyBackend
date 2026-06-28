import { Injectable, BadRequestException } from '@nestjs/common';
import { DOMParser } from '@xmldom/xmldom';
import { gpx } from '@tmcw/togeojson';
import { FeatureCollection, LineString, Feature } from 'geojson';

export interface ParsedGpxResult {
  geoJson: Feature<LineString>;
  totalDistanceMeters: number;
  totalElevationMeters: number;
  startPoint: { lat: number; lng: number } | null;
  finishPoint: { lat: number; lng: number } | null;
}

@Injectable()
export class GpxParserService {
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
        (f) =>
          f.geometry.type === 'LineString' ||
          f.geometry.type === 'MultiLineString',
      ) as Feature<LineString>;

      if (!routeFeature) {
        throw new BadRequestException(
          'No route (LineString) found in GPX file',
        );
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

      const coordinates = routeFeature.geometry.coordinates;
      if (!coordinates || coordinates.length < 2) {
        throw new BadRequestException(
          'GPX route does not contain enough coordinates',
        );
      }

      let totalDistance = 0;
      let totalElevation = 0;

      for (let i = 1; i < coordinates.length; i++) {
        const prev = coordinates[i - 1];
        const curr = coordinates[i];

        // coordinates[0] = lng, coordinates[1] = lat, coordinates[2] = elevation (optional)
        const d = this.calculateHaversineDistance(
          prev[1],
          prev[0],
          curr[1],
          curr[0],
        );
        totalDistance += d;

        if (prev.length > 2 && curr.length > 2) {
          const eleDiff = curr[2] - prev[2];
          if (eleDiff > 0) {
            totalElevation += eleDiff; // Cumulative elevation gain
          }
        }
      }

      const startPoint = { lat: coordinates[0][1], lng: coordinates[0][0] };
      const lastCoord = coordinates[coordinates.length - 1];
      const finishPoint = { lat: lastCoord[1], lng: lastCoord[0] };

      return {
        geoJson: routeFeature,
        totalDistanceMeters: Math.round(totalDistance),
        totalElevationMeters: Math.round(totalElevation),
        startPoint,
        finishPoint,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        'Failed to parse GPX file: ' + error.message,
      );
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
