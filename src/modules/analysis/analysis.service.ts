import { Injectable, Inject, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';
import * as turf from '@turf/turf';
import { LineString } from 'geojson';

@Injectable()
export class AnalysisService {
    private readonly logger = new Logger(AnalysisService.name);

    constructor(
        private redisService: RedisService,
        @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    ) { }

    async detectAnomalies(
        eventId: number,
        userId: number,
        currentLat: number,
        currentLng: number,
        currentSpeed: number | null,
        timestamp: Date,
    ) {
        const detectedAnomalies: any[] = [];
        try {
            // Fetch event to determine category for adaptive thresholds
            const event = await this.db.query.events.findFirst({
                where: eq(schema.events.id, eventId)
            });

            if (!event) {
                this.logger.warn(`Event ${eventId} not found during anomaly detection`);
                return detectedAnomalies;
            }

            // 1. STUCK Anomaly check (Comparing to previous Redis position)
            const prevPos = await this.redisService.getPreviousPosition(eventId, userId);
            const stats = await this.redisService.getParticipantStats(userId);

            if (prevPos && stats && stats.last_seen) {
                const lastSeen = new Date(stats.last_seen);
                const timeDiffMinutes = (timestamp.getTime() - lastSeen.getTime()) / (1000 * 60);

                const pt1 = turf.point([prevPos.lng, prevPos.lat]);
                const pt2 = turf.point([currentLng, currentLat]);
                const distanceMeters = turf.distance(pt1, pt2, { units: 'meters' });

                // Criteria: Distance moved < 5m over >= 5 minutes
                if (distanceMeters < 5 && timeDiffMinutes >= 5) {
                    const anomaly = await this.insertAnomaly(eventId, userId, currentLat, currentLng, 'STUCK', `User hasn't moved more than 5m in ${Math.round(timeDiffMinutes)} minutes.`);
                    detectedAnomalies.push(anomaly);
                }
            }

            // 2. TOO_FAST Anomaly check — ADAPTIVE by event category
            const MAX_SPEED_KMH = event.category === 'CYCLING' ? 100 : 45;
            if (currentSpeed !== null && currentSpeed > MAX_SPEED_KMH) {
                const categoryLabel = event.category === 'CYCLING' ? 'cycling' : 'running';
                const anomaly = await this.insertAnomaly(
                    eventId, userId, currentLat, currentLng, 'TOO_FAST',
                    `Speed detected at ${currentSpeed.toFixed(1)} km/h exceeds ${categoryLabel} threshold of ${MAX_SPEED_KMH} km/h.`,
                );
                detectedAnomalies.push(anomaly);
            }

            // 3. OFF-ROUTE Anomaly check (Using DB route GeoJSON)
            if (event.routeGeojson) {
                const route = event.routeGeojson as LineString; // Assumes a valid LineString
                const currentPt = turf.point([currentLng, currentLat]);

                try {
                    // Calculate shortest distance from current point to the route linestring
                    // @ts-ignore: Turf typings can be tricky depending on version
                    const distToRouteMeters = turf.pointToLineDistance(currentPt, turf.lineString(route.coordinates), { units: 'meters' });

                    if (distToRouteMeters > 50) { // Off route threshold 50m
                        const anomaly = await this.insertAnomaly(eventId, userId, currentLat, currentLng, 'OFF_ROUTE', `User is ${Math.round(distToRouteMeters)}m away from the designated route.`);
                        detectedAnomalies.push(anomaly);
                    }
                } catch (e) {
                    this.logger.error(`Error calculating route distance: ${e}`);
                }
            }

        } catch (error) {
            this.logger.error('Error in detectAnomalies process', error);
        }
        return detectedAnomalies;
    }

    private async insertAnomaly(eventId: number, userId: number, lat: number, lng: number, type: string, reason: string) {
        const [anomaly] = await this.db.insert(schema.anomalies).values({
            eventId,
            userId,
            latitude: lat,
            longitude: lng,
            type,
            reason,
        }).returning();
        this.logger.warn(`Anomaly detected: [${type}] User ${userId} on Event ${eventId}`);
        return anomaly;
    }
}
