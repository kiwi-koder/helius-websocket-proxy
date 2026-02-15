/** A single subscription: one client sub ↔ one upstream sub */
export interface Subscription {
  /** Proxy-generated subscription ID sent to the client */
  proxySubId: string;
  /** The connection that owns this subscription */
  connectionId: string;
  /** Helius subscription method, e.g. "accountSubscribe" */
  method: string;
  /** Original params sent to Helius */
  params: unknown[];
  /** Helius-assigned subscription ID (set once subscribe succeeds) */
  heliusSubId: number | null;
  /** Promise for in-flight subscribe */
  pendingPromise: Promise<number> | null;
  /** Flag for pending-subscribe cancellation */
  cancelled: boolean;
  /** Grace period timer for deferred upstream unsubscribe */
  unsubscribeTimer: ReturnType<typeof setTimeout> | null;
}
