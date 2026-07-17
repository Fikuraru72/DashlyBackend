// ═══════════════════════════════════════════════════════════════════
// TrackingEvent — The unified event contract for the entire pipeline.
// Every module after ingestion communicates using this interface.
// ═══════════════════════════════════════════════════════════════════

/**
 * The canonical event produced by the Validator and consumed by all
 * downstream pipeline stages. Fields marked "enriched" are populated
 * by the EnrichmentConsumer; they are `null` when first published to
 * the `tracking-events-raw` queue.
 */
export interface TrackingEvent {
  // ─── Identity ───────────────────────────────────────────────
  eventId: number;
  participantId: number;
  userId: number;
  messageId: string;

  // ─── Geospatial ─────────────────────────────────────────────
  lat: number;
  lng: number;
  altitude?: number;
  speedFromClient: number;

  // ─── Enriched by EnrichmentConsumer ──────────────────────────
  /** Meters between this point and the previous accepted point. */
  speedCalculated: number | null;
  /** Metres/second computed from haversine + time delta. */
  distanceDelta: number | null;

  // ─── Temporal ───────────────────────────────────────────────
  /** ISO-8601 string — when the mobile captured the GPS fix. */
  capturedAt: string;
  /** ISO-8601 string — when the server first received the message. */
  serverReceivedAt: string;

  // ─── Flags (set by EnrichmentConsumer) ──────────────────────
  flags: TrackingEventFlags;

  // ─── Metadata ───────────────────────────────────────────────
  battery?: number;
  /** Raw status string from the mobile client ('moving', etc.). */
  clientStatus: string;
  /**
   * Classification assigned by the enrichment layer.
   * - VALID:   accepted for DB + WS broadcast
   * - ANOMALY: flagged but still persisted (teleport / speed spike)
   * - LATE:    out-of-order timestamp — persisted but NOT broadcast
   * - SYNC:    offline-recovery batch point
   */
  gatekeeperAction: GatekeeperAction;

  // ─── Intelligence (populated by IntelligenceConsumer) ───────
  /** Set by the intelligence consumer after progress/ranking/alert computation. */
  intelligence?: IntelligenceResult;
}

export interface TrackingEventFlags {
  isAnomaly: boolean;
  isStopped: boolean;
  isOffline: boolean;
  /** Timestamp is older than the current Redis state for this participant. */
  isLate: boolean;
  /** GPS drift or stationary noise that should skip distance/ranking calculations. */
  isNoise?: boolean;
}

export type GatekeeperAction = 'VALID' | 'ANOMALY' | 'LATE' | 'SYNC';

// ═══════════════════════════════════════════════════════════════════
// Phase 1 — Intelligence Result
// ═══════════════════════════════════════════════════════════════════

/** Output of the intelligence consumer, attached to each enriched event. */
export interface IntelligenceResult {
  /** Route completion percentage (0–100). */
  progressPercentage: number;
  /** Metres remaining to the finish line. */
  distanceToFinish: number;
  /** Closest point on the route (snapped). */
  snappedLat: number;
  snappedLng: number;
  /** 1-based rank among active participants. */
  rank: number;
  /** Total tracked participants in the ranking set. */
  totalParticipants: number;
  /** True if the participant is off-route (3+ consecutive off-route points). */
  offRoute: boolean;
  /** Perpendicular distance from participant to route (metres). */
  offRouteDistance: number;
  /** True if participant speed < 0.5 m/s for > 60 seconds. */
  stopped: boolean;
  /** How long the participant has been idle (seconds). */
  stoppedDurationSec: number;
  /** Hybrid ranking score. */
  score: number;
  /** Participant state after intelligence processing. */
  participantState: string;
  /** Cumulative elevation gain (metres). */
  elevationGain?: number;
  /** Minimum altitude recorded (metres). */
  minAltitude?: number;
  /** Maximum altitude recorded (metres). */
  maxAltitude?: number;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1 — Pre-Processed Route (cached in Redis + in-memory)
// ═══════════════════════════════════════════════════════════════════

/** GPX route pre-processed for O(1) progress lookup. */
export interface ProcessedRoute {
  /** Coordinates in GeoJSON order [lng, lat]. */
  coordinates: [number, number][];
  /** Cumulative distance from start for each coordinate (metres). */
  cumulativeDistances: number[];
  /** Total route length in metres. */
  totalDistance: number;
  /** Number of line segments (coordinates.length - 1). */
  segmentCount: number;
}

// ─── SOS Event (fast-path — bypasses the queue) ──────────────────
/** Published to the enriched queue for audit logging only. */
export interface SosEvent {
  eventId: number;
  participantId: number;
  userId: number;
  lat: number;
  lng: number;
  timestamp: string;
}

// ─── Raw Ingest Payload (internal, pre-validation) ───────────────
/** The raw shape extracted by MqttIngestService before normalisation. */
export interface RawIngestPayload {
  eventId: number;
  participantId: number;
  userId: number;
  msgId: string;
  lat: string | number;
  lng: string | number;
  altitude?: string | number;
  speed: string | number;
  battery?: string | number;
  capturedAt: string | null;
  status: string;
}

// ─── Redis State Shapes ──────────────────────────────────────────
export interface ParticipantCacheState {
  lat: number;
  lng: number;
  speed: number;
  capturedAt: number; // epoch ms
  isOffline: boolean;
  lastSeen: string; // ISO
  lastMoved: string; // ISO
}

// ─── Queue Names (single source of truth) ────────────────────────
export const QUEUE_TRACKING_RAW = 'tracking-events-raw';
export const QUEUE_TRACKING_ENRICHED = 'tracking-events-enriched';
