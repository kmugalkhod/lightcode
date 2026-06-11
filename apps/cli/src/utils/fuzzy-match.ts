const BOUNDARY_CHARS = new Set(["/", "\\", ".", "-", "_"]);

/**
 * Subsequence fuzzy score: higher is better, null when the query is not a
 * subsequence of the candidate. Rewards consecutive runs and matches that
 * start path segments; mildly penalizes long candidates.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const normalizedQuery = query.toLowerCase();
  const normalizedCandidate = candidate.toLowerCase();

  if (!normalizedQuery) {
    return 0;
  }

  let score = 0;
  let candidateIndex = 0;
  let previousMatchIndex = -2;

  for (const queryChar of normalizedQuery) {
    const foundIndex = normalizedCandidate.indexOf(queryChar, candidateIndex);
    if (foundIndex === -1) {
      return null;
    }

    score += 1;
    if (foundIndex === previousMatchIndex + 1) {
      score += 2; // consecutive run
    }
    if (foundIndex === 0 || BOUNDARY_CHARS.has(normalizedCandidate[foundIndex - 1])) {
      score += 3; // segment start
    }

    previousMatchIndex = foundIndex;
    candidateIndex = foundIndex + 1;
  }

  return score - candidate.length / 100;
}

export function fuzzyFilter(
  query: string,
  candidates: readonly string[],
  limit = 6,
): string[] {
  return candidates
    .map((candidate) => ({ candidate, score: fuzzyScore(query, candidate) }))
    .filter((entry): entry is { candidate: string; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
