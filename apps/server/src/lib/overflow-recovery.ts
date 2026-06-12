/**
 * Progressive context-overflow recovery (ported from claw-code): when the
 * provider rejects a request as too large, each client retry triggers a
 * harder forced compaction — preserving 4, then 2, 1, and finally 0 recent
 * messages uncompacted — before the request is rebuilt. Full history on disk
 * is never touched; only the provider view shrinks. Entries clear on the
 * first successful finish.
 */
const overflowPreserveSchedule = [4, 2, 1, 0] as const;
const overflowRecoveryRounds = new Map<string, number>();

export function noteContextOverflow(sessionId: string) {
  overflowRecoveryRounds.set(
    sessionId,
    (overflowRecoveryRounds.get(sessionId) ?? 0) + 1,
  );
}

export function clearContextOverflowRounds(sessionId: string) {
  overflowRecoveryRounds.delete(sessionId);
}

/**
 * How many recent messages the next attempt may keep uncompacted, or null
 * when the session is not in overflow recovery.
 */
export function getOverflowPreserveRecentMessages(
  sessionId: string,
): number | null {
  const rounds = overflowRecoveryRounds.get(sessionId) ?? 0;
  if (rounds === 0) {
    return null;
  }

  return overflowPreserveSchedule[
    Math.min(rounds, overflowPreserveSchedule.length) - 1
  ];
}
