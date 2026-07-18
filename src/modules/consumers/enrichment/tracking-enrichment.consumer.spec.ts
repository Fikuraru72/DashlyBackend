import { describe, expect, it, vi } from 'vitest';

import { TrackingEvent } from '../../common/interfaces/tracking-event.interface';
import { TrackingEnrichmentConsumer } from './tracking-enrichment.consumer';

type ConsumerInternals = {
  participantLockRetryMs: number;
  process: (event: TrackingEvent) => Promise<void>;
  processWithParticipantLock: (event: TrackingEvent) => Promise<void>;
};

describe('TrackingEnrichmentConsumer participant serialization', () => {
  it('serializes one participant across replicas while processing different participants in parallel', async () => {
    const locks = new Map<string, string>();
    const redisService = {
      acquireOwnedLock: vi.fn(async (key: string, token: string) => {
        if (locks.has(key)) return false;
        locks.set(key, token);
        return true;
      }),
      extendOwnedLock: vi.fn(async (key: string, token: string) => locks.get(key) === token),
      releaseOwnedLock: vi.fn(async (key: string, token: string) => {
        if (locks.get(key) === token) locks.delete(key);
      }),
    };
    const createConsumer = () =>
      new TrackingEnrichmentConsumer(
        {} as never,
        redisService as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as ConsumerInternals;

    const replicas = [createConsumer(), createConsumer()];
    const activeByParticipant = new Map<number, number>();
    let activeTotal = 0;
    let maxActiveTotal = 0;
    let sameParticipantOverlap = false;
    const processed: string[] = [];

    for (const replica of replicas) {
      replica.participantLockRetryMs = 1;
      replica.process = async (event) => {
        const participantActive = (activeByParticipant.get(event.participantId) ?? 0) + 1;
        activeByParticipant.set(event.participantId, participantActive);
        sameParticipantOverlap ||= participantActive > 1;
        activeTotal++;
        maxActiveTotal = Math.max(maxActiveTotal, activeTotal);

        await new Promise((resolve) => setTimeout(resolve, 20));
        processed.push(event.messageId);

        activeTotal--;
        activeByParticipant.set(event.participantId, participantActive - 1);
      };
    }

    const event = (messageId: string, participantId: number) =>
      ({ eventId: 16, participantId, messageId }) as TrackingEvent;

    await Promise.all([
      replicas[0].processWithParticipantLock(event('p81-a', 81)),
      replicas[1].processWithParticipantLock(event('p81-b', 81)),
      replicas[1].processWithParticipantLock(event('p82-a', 82)),
    ]);

    expect(sameParticipantOverlap).toBe(false);
    expect(maxActiveTotal).toBeGreaterThanOrEqual(2);
    expect(processed).toHaveLength(3);
    expect(locks.size).toBe(0);
  });
});
