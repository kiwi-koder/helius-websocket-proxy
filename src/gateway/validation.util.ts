import { ClientMessage } from './client-message.types';

const VALID_METHODS = new Set([
  'accountSubscribe',
  'programSubscribe',
  'logsSubscribe',
  'slotSubscribe',
  'signatureSubscribe',
  'rootSubscribe',
]);

export function validateClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as Record<string, unknown>;

  if (msg.action === 'subscribe') {
    if (typeof msg.method !== 'string') return null;
    if (!VALID_METHODS.has(msg.method)) return null;
    const params = msg.params;
    if (params !== undefined && !Array.isArray(params)) return null;
    return {
      action: 'subscribe',
      method: msg.method,
      params: (params as unknown[]) ?? [],
    };
  }

  if (msg.action === 'unsubscribe') {
    if (typeof msg.subscriptionId !== 'string') return null;
    return { action: 'unsubscribe', subscriptionId: msg.subscriptionId };
  }

  return null;
}
