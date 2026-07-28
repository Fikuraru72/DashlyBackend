import { Injectable, Logger } from '@nestjs/common';

/**
 * RoutePreprocessorService — GPX route normalization + densification pipeline.
 *
 * This service transforms raw GPX coordinates into a clean, densified route
 * suitable for high-precision snap-to-route operations.
 *
 * Pipeline stages:
 *   1. Invalid coordinate filter
 *   2. Duplicate point removal
 *   3. Geometry spike filter
 *   4. Zero-length segment removal
 *   5. Elevation validation
 *   6. Elevation spike filter (3-point median)
 *   7. Zig-zag smoothing
 *   8. Densification (adaptive, configurable target spacing)
 *
 * All stages are idempotent and order-dependent.
 * Runs once at event creation time — zero impact on real-time latency.
 */
@Injectable()
export class RoutePreprocessorService {
  private readonly logger = new Logger(RoutePreprocessorService.name);

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  /**
   * Full pipeline: normalize + densify.
   *
   * @param coordinates  Raw [lng, lat, ele?][] from GPX parser
   * @param options      Preprocessing configuration
   * @returns Cleaned, densified coordinates with elevation
   */
  preprocessRoute(coordinates: number[][], options: PreprocessOptions = {}): PreprocessResult {
    const opts: Required<PreprocessOptions> = {
      targetSpacing: options.targetSpacing ?? 15,
      adaptiveDensification: options.adaptiveDensification ?? true,
      minElevation: options.minElevation ?? -500,
      maxElevation: options.maxElevation ?? 9000,
      maxGradePercent: options.maxGradePercent ?? 100,
      duplicateThresholdMeters: options.duplicateThresholdMeters ?? 0.5,
      spikeAngleDegrees: options.spikeAngleDegrees ?? 150,
      spikeMaxLengthMeters: options.spikeMaxLengthMeters ?? 50,
    };

    const stats: NormalizationStats = {
      inputPoints: coordinates.length,
      removedInvalid: 0,
      removedDuplicates: 0,
      removedSpikes: 0,
      removedZeroLength: 0,
      elevationsCorrected: 0,
      elevationSpikesSmoothed: 0,
      zigzagSmoothed: 0,
      pointsDensified: 0,
      outputPoints: 0,
    };

    let coords = this.toTriples(coordinates);
    this.logger.log(`[Preprocess] Starting with ${coords.length} raw points`);

    // Stage 1: Invalid coordinate filter
    const beforeInvalid = coords.length;
    coords = this.filterInvalidCoordinates(coords);
    stats.removedInvalid = beforeInvalid - coords.length;
    if (stats.removedInvalid > 0) {
      this.logger.log(`[Preprocess] Stage 1: Removed ${stats.removedInvalid} invalid coordinates`);
    }

    // Stage 2: Duplicate point removal
    const beforeDuplicates = coords.length;
    coords = this.removeDuplicates(coords, opts.duplicateThresholdMeters);
    stats.removedDuplicates = beforeDuplicates - coords.length;
    if (stats.removedDuplicates > 0) {
      this.logger.log(`[Preprocess] Stage 2: Removed ${stats.removedDuplicates} duplicate points`);
    }

    // Stage 3: Geometry spike filter
    const beforeSpikes = coords.length;
    coords = this.filterGeometrySpikes(coords, opts.spikeAngleDegrees, opts.spikeMaxLengthMeters);
    stats.removedSpikes = beforeSpikes - coords.length;
    if (stats.removedSpikes > 0) {
      this.logger.log(`[Preprocess] Stage 3: Removed ${stats.removedSpikes} geometry spikes`);
    }

    // Stage 4: Zero-length segment removal (re-scan after spike removal)
    const beforeZero = coords.length;
    coords = this.removeZeroLengthSegments(coords);
    stats.removedZeroLength = beforeZero - coords.length;
    if (stats.removedZeroLength > 0) {
      this.logger.log(
        `[Preprocess] Stage 4: Removed ${stats.removedZeroLength} zero-length segments`,
      );
    }

    // Stage 5: Elevation validation
    stats.elevationsCorrected = this.validateElevations(
      coords,
      opts.minElevation,
      opts.maxElevation,
    );
    if (stats.elevationsCorrected > 0) {
      this.logger.log(
        `[Preprocess] Stage 5: Corrected ${stats.elevationsCorrected} invalid elevations`,
      );
    }

    // Stage 6: Elevation spike filter (3-point median)
    stats.elevationSpikesSmoothed = this.smoothElevationSpikes(coords, opts.maxGradePercent);
    if (stats.elevationSpikesSmoothed > 0) {
      this.logger.log(
        `[Preprocess] Stage 6: Smoothed ${stats.elevationSpikesSmoothed} elevation spikes`,
      );
    }

    // Stage 7: Zig-zag smoothing
    stats.zigzagSmoothed = this.smoothZigzag(coords);
    if (stats.zigzagSmoothed > 0) {
      this.logger.log(`[Preprocess] Stage 7: Smoothed ${stats.zigzagSmoothed} zig-zag points`);
    }

    // Stage 8: Densification
    const beforeDensify = coords.length;
    coords = opts.adaptiveDensification
      ? this.densifyAdaptive(coords, opts.targetSpacing)
      : this.densifyUniform(coords, opts.targetSpacing);
    stats.pointsDensified = coords.length - beforeDensify;
    if (stats.pointsDensified > 0) {
      this.logger.log(
        `[Preprocess] Stage 8: Added ${stats.pointsDensified} densification points (${beforeDensify} → ${coords.length})`,
      );
    }

    stats.outputPoints = coords.length;
    this.logger.log(`[Preprocess] Complete: ${stats.inputPoints} → ${stats.outputPoints} points`);

    return {
      coordinates: coords,
      stats,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 1: Invalid Coordinate Filter
  // ═══════════════════════════════════════════════════════════════

  private filterInvalidCoordinates(coords: Triple[]): Triple[] {
    return coords.filter(([lng, lat]) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
      // Don't filter by elevation here — Stage 5 handles it
      return true;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 2: Duplicate Point Removal
  // ═══════════════════════════════════════════════════════════════

  private removeDuplicates(coords: Triple[], thresholdMeters: number): Triple[] {
    if (coords.length < 2) return coords;
    const result: Triple[] = [coords[0]];

    for (let i = 1; i < coords.length; i++) {
      const prev = result[result.length - 1];
      const dist = this.euclideanDistMeters(prev[1], prev[0], coords[i][1], coords[i][0]);
      if (dist >= thresholdMeters) {
        result.push(coords[i]);
      }
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 3: Geometry Spike Filter
  // ═══════════════════════════════════════════════════════════════

  private filterGeometrySpikes(
    coords: Triple[],
    maxAngleDeg: number,
    maxSegLenMeters: number,
  ): Triple[] {
    if (coords.length < 3) return coords;

    const keep: boolean[] = Array.from({ length: coords.length }, () => true);

    for (let i = 1; i < coords.length - 1; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];
      const next = coords[i + 1];

      // Compute the angle at curr between segments prev→curr and curr→next
      const angle = this.angleBetweenSegments(prev[1], prev[0], curr[1], curr[0], next[1], next[0]);

      const segLen = this.euclideanDistMeters(prev[1], prev[0], curr[1], curr[0]);

      // A spike: very sharp angle + short segment
      if (angle > maxAngleDeg && segLen < maxSegLenMeters) {
        keep[i] = false;
      }
    }

    return coords.filter((_, idx) => keep[idx]);
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 4: Zero-Length Segment Removal
  // ═══════════════════════════════════════════════════════════════

  private removeZeroLengthSegments(coords: Triple[]): Triple[] {
    if (coords.length < 2) return coords;
    const result: Triple[] = [coords[0]];

    for (let i = 1; i < coords.length; i++) {
      const prev = result[result.length - 1];
      const dist = this.euclideanDistMeters(prev[1], prev[0], coords[i][1], coords[i][0]);
      if (dist >= 0.1) {
        result.push(coords[i]);
      }
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 5: Elevation Validation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Replace invalid elevation values with interpolated neighbors.
   * Mutates in-place. Returns count of corrections.
   */
  private validateElevations(coords: Triple[], minEle: number, maxEle: number): number {
    let corrected = 0;

    for (let i = 0; i < coords.length; i++) {
      const ele = coords[i][2];
      if (!Number.isFinite(ele) || ele < minEle || ele > maxEle) {
        // Interpolate from nearest valid neighbors
        const prevValid = this.findValidElevation(coords, i, -1, minEle, maxEle);
        const nextValid = this.findValidElevation(coords, i, 1, minEle, maxEle);

        if (prevValid !== null && nextValid !== null) {
          coords[i][2] = (prevValid + nextValid) / 2;
        } else if (prevValid !== null) {
          coords[i][2] = prevValid;
        } else if (nextValid !== null) {
          coords[i][2] = nextValid;
        } else {
          coords[i][2] = 0; // No valid elevation data at all
        }
        corrected++;
      }
    }

    return corrected;
  }

  private findValidElevation(
    coords: Triple[],
    startIdx: number,
    direction: 1 | -1,
    minEle: number,
    maxEle: number,
  ): number | null {
    for (let i = startIdx + direction; i >= 0 && i < coords.length; i += direction) {
      const ele = coords[i][2];
      if (Number.isFinite(ele) && ele >= minEle && ele <= maxEle) {
        return ele;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 6: Elevation Spike Filter (3-point Median)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Detect elevation spikes where the grade exceeds maxGradePercent.
   * Apply 3-point median filter to smooth them.
   * Mutates in-place. Returns count of smoothed spikes.
   */
  private smoothElevationSpikes(coords: Triple[], maxGradePercent: number): number {
    if (coords.length < 3) return 0;

    let smoothed = 0;
    const maxGradeFraction = maxGradePercent / 100; // e.g., 100% → 1.0

    for (let i = 1; i < coords.length - 1; i++) {
      const prevCoord = coords[i - 1];
      const currCoord = coords[i];
      const nextCoord = coords[i + 1];

      const distPrev = this.euclideanDistMeters(
        prevCoord[1],
        prevCoord[0],
        currCoord[1],
        currCoord[0],
      );
      const distNext = this.euclideanDistMeters(
        currCoord[1],
        currCoord[0],
        nextCoord[1],
        nextCoord[0],
      );

      if (distPrev < 0.1 || distNext < 0.1) continue;

      const gradePrev = Math.abs(currCoord[2] - prevCoord[2]) / distPrev;
      const gradeNext = Math.abs(nextCoord[2] - currCoord[2]) / distNext;

      // If BOTH incoming and outgoing grades are extreme, it's a spike
      if (gradePrev > maxGradeFraction && gradeNext > maxGradeFraction) {
        // 3-point median
        const values = [prevCoord[2], currCoord[2], nextCoord[2]].sort((a, b) => a - b);
        const median = values[1];
        if (median !== currCoord[2]) {
          coords[i][2] = median;
          smoothed++;
        }
      }
    }

    return smoothed;
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 7: Zig-Zag Smoothing
  // ═══════════════════════════════════════════════════════════════

  /**
   * Apply a 3-point weighted average on coordinates where consecutive
   * points are very close (< 2m spacing), indicating GPS drift at standstill.
   * Mutates in-place. Returns count of smoothed points.
   */
  private smoothZigzag(coords: Triple[]): number {
    if (coords.length < 3) return 0;

    let smoothed = 0;

    for (let i = 1; i < coords.length - 1; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];
      const next = coords[i + 1];

      const dPrev = this.euclideanDistMeters(prev[1], prev[0], curr[1], curr[0]);
      const dNext = this.euclideanDistMeters(curr[1], curr[0], next[1], next[0]);

      // Only smooth if both neighboring segments are very short (GPS drift zone)
      if (dPrev < 2 && dNext < 2) {
        // Weighted average: (0.25, 0.5, 0.25)
        coords[i][0] = 0.25 * prev[0] + 0.5 * curr[0] + 0.25 * next[0]; // lng
        coords[i][1] = 0.25 * prev[1] + 0.5 * curr[1] + 0.25 * next[1]; // lat
        // Don't smooth elevation here — handled by Stage 6
        smoothed++;
      }
    }

    return smoothed;
  }

  // ═══════════════════════════════════════════════════════════════
  //  STAGE 8: Densification
  // ═══════════════════════════════════════════════════════════════

  /**
   * Uniform densification: insert interpolated points into segments
   * longer than targetSpacing meters.
   */
  private densifyUniform(coords: Triple[], targetSpacing: number): Triple[] {
    if (coords.length < 2) return coords;

    const result: Triple[] = [coords[0]];

    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];

      const segLen = this.euclideanDistMeters(prev[1], prev[0], curr[1], curr[0]);

      if (segLen > targetSpacing) {
        const n = Math.ceil(segLen / targetSpacing);
        for (let j = 1; j < n; j++) {
          const t = j / n;
          result.push([
            prev[0] + t * (curr[0] - prev[0]), // lng
            prev[1] + t * (curr[1] - prev[1]), // lat
            prev[2] + t * (curr[2] - prev[2]), // ele (linear interp)
          ]);
        }
      }

      result.push(curr);
    }

    return result;
  }

  /**
   * Adaptive densification: denser at curves, sparser on straights.
   * Tight turns (>30°) get 5m spacing, moderate curves 10m, straights 20m.
   */
  private densifyAdaptive(coords: Triple[], baseSpacing: number): Triple[] {
    if (coords.length < 2) return coords;

    const result: Triple[] = [coords[0]];

    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1];
      const curr = coords[i];

      // Compute angle at current point (if not first or last)
      let targetSpacing = baseSpacing;
      if (i < coords.length - 1) {
        const next = coords[i + 1];
        const angle = this.angleBetweenSegments(
          prev[1],
          prev[0],
          curr[1],
          curr[0],
          next[1],
          next[0],
        );

        // Higher angle = tighter turn = denser spacing
        if (angle > 30) {
          targetSpacing = Math.max(5, baseSpacing / 3); // Tight turn
        } else if (angle > 10) {
          targetSpacing = Math.max(8, baseSpacing / 2); // Moderate curve
        }
        // else: straight, use baseSpacing
      }

      const segLen = this.euclideanDistMeters(prev[1], prev[0], curr[1], curr[0]);

      if (segLen > targetSpacing) {
        const n = Math.ceil(segLen / targetSpacing);
        for (let j = 1; j < n; j++) {
          const t = j / n;
          result.push([
            prev[0] + t * (curr[0] - prev[0]),
            prev[1] + t * (curr[1] - prev[1]),
            prev[2] + t * (curr[2] - prev[2]),
          ]);
        }
      }

      result.push(curr);
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GEOMETRY UTILITIES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Fast Euclidean distance approximation in meters.
   * Accurate to ~0.1% at typical cycling latitudes (±10°).
   */
  private euclideanDistMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const M_PER_DEG_LAT = 111_320;
    const cosLat = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    const M_PER_DEG_LNG = 111_320 * cosLat;

    const dx = (lng2 - lng1) * M_PER_DEG_LNG;
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Compute the angle (in degrees) between two consecutive segments.
   * (aLat,aLng) → (bLat,bLng) → (cLat,cLng).
   * A straight path returns ~0°; a U-turn returns ~180°.
   */
  private angleBetweenSegments(
    aLat: number,
    aLng: number,
    bLat: number,
    bLng: number,
    cLat: number,
    cLng: number,
  ): number {
    const cosLat = Math.cos((bLat * Math.PI) / 180);
    const v1x = (bLng - aLng) * cosLat;
    const v1y = bLat - aLat;
    const v2x = (cLng - bLng) * cosLat;
    const v2y = cLat - bLat;

    const dot = v1x * v2x + v1y * v2y;
    const cross = v1x * v2y - v1y * v2x;

    return Math.abs((Math.atan2(cross, dot) * 180) / Math.PI);
  }

  /**
   * Ensure every coordinate has exactly 3 elements: [lng, lat, elevation].
   * If elevation is missing, default to 0.
   */
  private toTriples(coords: number[][]): Triple[] {
    return coords.map((c) => [
      c[0], // lng
      c[1], // lat
      c.length > 2 && Number.isFinite(c[2]) ? c[2] : 0, // elevation
    ]);
  }
}

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

/** [lng, lat, elevation] — GeoJSON order */
type Triple = [number, number, number];

export interface PreprocessOptions {
  /** Target spacing in meters for densification. Default: 15 */
  targetSpacing?: number;
  /** Use adaptive densification (denser at curves). Default: true */
  adaptiveDensification?: boolean;
  /** Minimum valid elevation in meters. Default: -500 (Dead Sea) */
  minElevation?: number;
  /** Maximum valid elevation in meters. Default: 9000 (Everest) */
  maxElevation?: number;
  /** Maximum allowed grade percentage before spike filter. Default: 100 */
  maxGradePercent?: number;
  /** Minimum distance between points before duplicate removal. Default: 0.5m */
  duplicateThresholdMeters?: number;
  /** Angle threshold for geometry spike detection. Default: 150° */
  spikeAngleDegrees?: number;
  /** Max segment length for spike candidate. Default: 50m */
  spikeMaxLengthMeters?: number;
}

export interface NormalizationStats {
  inputPoints: number;
  removedInvalid: number;
  removedDuplicates: number;
  removedSpikes: number;
  removedZeroLength: number;
  elevationsCorrected: number;
  elevationSpikesSmoothed: number;
  zigzagSmoothed: number;
  pointsDensified: number;
  outputPoints: number;
}

export interface PreprocessResult {
  coordinates: Triple[];
  stats: NormalizationStats;
}
