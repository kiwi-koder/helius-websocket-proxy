import { createHash } from 'crypto';

/**
 * Produces a stable SHA-256 hex key for a subscription request
 * so that identical subscriptions from different clients are deduped.
 */
export function canonicalKey(method: string, params: unknown[]): string {
  const payload = JSON.stringify({ method, params: sortDeep(params) });
  return createHash('sha256').update(payload).digest('hex');
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}
