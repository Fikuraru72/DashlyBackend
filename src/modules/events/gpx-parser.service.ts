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

      // Collect all line segments from the GPX
      const allSegments: number[][][] = [];
      
      for (const f of geoJson.features) {
        if (f.geometry.type === 'LineString') {
           allSegments.push(f.geometry.coordinates as number[][]);
        } else if (f.geometry.type === 'MultiLineString') {
           allSegments.push(...(f.geometry.coordinates as number[][][]));
        }
      }

      if (allSegments.length === 0) {
        throw new BadRequestException(
          'No route (LineString) found in GPX file',
        );
      }

      // Find the longest segment to discard branches/pit-lanes
      let longestSegment = allSegments[0];
      let maxLen = -1;
      
      for (const segment of allSegments) {
        let len = 0;
        for (let i = 1; i < segment.length; i++) {
          const prev = segment[i - 1];
          const curr = segment[i];
          len += this.calculateHaversineDistance(
            prev[1], prev[0], curr[1], curr[0]
          );
        }
        if (len > maxLen) {
          maxLen = len;
          longestSegment = segment;
        }
      }

      const routeFeature: Feature<LineString> = {
        type: 'Feature',
        properties: { source: 'gpx' },
        geometry: {
          type: 'LineString',
          coordinates: longestSegment,
        },
      };

      const coordinates = routeFeature.geometry.coordinates;
      if (!coordinates || coordinates.length < 2) {
        throw new BadRequestException(
          'GPX route does not contain enough coordinates',
        );
      }

      let totalDistance = 0;
      let totalElevation = 0;
      let cumGain = 0;
      let cumLoss = 0;

      const altitudeProfile: any[] = [];

      // Add the starting point to altitude profile
      if (coordinates.length > 0) {
        altitudeProfile.push({
          distance: 0,
          elevation: coordinates[0].length > 2 ? coordinates[0][2] : 0,
          lat: coordinates[0][1],
          lng: coordinates[0][0],
          cumGain: 0,
          cumLoss: 0,
        });
      }

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
            cumGain += eleDiff;
          } else {
            cumLoss += Math.abs(eleDiff);
          }
        }

        altitudeProfile.push({
          distance: Math.round(totalDistance),
          elevation: curr.length > 2 ? curr[2] : 0,
          lat: curr[1],
          lng: curr[0],
          cumGain: Math.round(cumGain),
          cumLoss: Math.round(cumLoss),
        });
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
        altitudeProfile,
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
