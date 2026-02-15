import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { UpstreamService } from '../upstream/upstream.service';
import { ClientConnectionService } from './client-connection.service';
import { Subscription } from './subscriptions.types';

/** Map from method → unsubscribe method */
const UNSUB_METHOD: Record<string, string> = {
  accountSubscribe: 'accountUnsubscribe',
  programSubscribe: 'programUnsubscribe',
  logsSubscribe: 'logsUnsubscribe',
  slotSubscribe: 'slotUnsubscribe',
  signatureSubscribe: 'signatureUnsubscribe',
  rootSubscribe: 'rootUnsubscribe',
};

/**
 * Core subscription manager that bridges client requests to upstream Helius
 * WebSocket subscriptions.
 *
 * Responsibilities:
 * - Creating upstream subscriptions on behalf of clients and tracking the
 *   mapping between proxy IDs (sent to clients) and Helius IDs (upstream).
 * - Routing incoming upstream notifications to the correct client connection.
 * - Re-subscribing all active subscriptions after an upstream reconnect.
 * - Implementing a grace-period idle cleanup so that briefly-disconnected
 *   clients don't lose their subscriptions.
 */
@Injectable()
export class SubscriptionsService implements OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionsService.name);

  /** proxy sub ID → subscription */
  private readonly subs = new Map<string, Subscription>();
  /** helius sub ID → proxy sub ID (for notification dispatch) */
  private readonly heliusIdToProxy = new Map<number, string>();
  /** connection ID → proxy sub ID */
  private readonly connToSub = new Map<string, string>();

  private readonly idleTimeoutMs: number;

  constructor(
    private readonly upstream: UpstreamService,
    private readonly clients: ClientConnectionService,
    private readonly config: ConfigService,
  ) {
    this.idleTimeoutMs = this.config.get<number>('IDLE_TIMEOUT_MS', 300000);
  }

  onModuleDestroy() {
    for (const sub of this.subs.values()) {
      if (sub.unsubscribeTimer) {
        clearTimeout(sub.unsubscribeTimer);
      }
    }
  }

  /**
   * Subscribe a client connection to an upstream Helius method.
   *
   * If the connection already owns a subscription, the old one is torn down
   * first (one subscription per connection). A new proxy subscription ID is
   * generated, the RPC request is sent upstream, and once Helius responds
   * the mapping is recorded for future notification dispatch.
   *
   * If the subscription is cancelled before the upstream response arrives
   * (e.g. client disconnects), the upstream subscription is immediately
   * cleaned up in the `.then()` handler.
   *
   * @param connectionId - UUID of the client connection.
   * @param method - Solana subscription method (e.g. `accountSubscribe`).
   * @param params - Parameters for the subscription RPC call.
   * @returns The proxy subscription ID to send back to the client.
   */
  async subscribe(
    connectionId: string,
    method: string,
    params: unknown[],
  ): Promise<string> {
    // Tear down existing subscription for this connection
    const existingProxyId = this.connToSub.get(connectionId);
    if (existingProxyId) {
      const existingSub = this.subs.get(existingProxyId);
      if (existingSub) {
        this.teardown(existingSub);
      }
    }

    const proxySubId = `sub_${randomUUID().slice(0, 12)}`;

    const sub: Subscription = {
      proxySubId,
      connectionId,
      method,
      params,
      heliusSubId: null,
      pendingPromise: null,
      cancelled: false,
      unsubscribeTimer: null,
    };
    this.subs.set(proxySubId, sub);
    this.connToSub.set(connectionId, proxySubId);

    // Send subscribe upstream
    const promise = this.upstream
      .sendRequest(method, params)
      .then((result) => {
        const heliusSubId = result as number;
        if (sub.cancelled) {
          this.logger.log(
            `Subscribe resolved but was cancelled, sending immediate unsubscribe: ${method} → ${heliusSubId}`,
          );
          const unsubMethod = UNSUB_METHOD[method];
          if (unsubMethod) {
            this.upstream
              .sendRequest(unsubMethod, [heliusSubId])
              .catch((err) =>
                this.logger.warn(`Cleanup unsubscribe failed: ${err}`),
              );
          }
          return heliusSubId;
        }
        sub.heliusSubId = heliusSubId;
        sub.pendingPromise = null;
        this.heliusIdToProxy.set(heliusSubId, proxySubId);
        this.logger.log(`Subscribed upstream: ${method} → helius id ${heliusSubId}`);
        return heliusSubId;
      })
      .catch((err) => {
        this.logger.error(`Upstream subscribe failed: ${err.message}`);
        sub.pendingPromise = null;
        this.removeSub(proxySubId);
        throw err;
      });

    sub.pendingPromise = promise;
    await promise;
    return proxySubId;
  }

  /**
   * Unsubscribe a single proxy subscription by its ID.
   *
   * Does not tear down the upstream subscription immediately — instead
   * schedules removal after the idle grace period so the slot can be
   * reclaimed if the client reconnects quickly.
   *
   * @returns `true` if the subscription existed and was scheduled for removal.
   */
  unsubscribe(proxySubId: string): boolean {
    const sub = this.subs.get(proxySubId);
    if (!sub) return false;

    this.connToSub.delete(sub.connectionId);

    // Schedule upstream teardown after grace period
    this.scheduleRemoval(sub);
    return true;
  }

  /**
   * Handle a client WebSocket disconnection.
   *
   * Looks up the subscription owned by this connection and schedules it
   * for removal after the idle grace period. The connection-to-subscription
   * mapping is deleted immediately.
   *
   * @param connectionId - UUID of the disconnected client.
   */
  handleDisconnect(connectionId: string) {
    const proxySubId = this.connToSub.get(connectionId);
    if (!proxySubId) return;

    const sub = this.subs.get(proxySubId);
    if (sub) {
      this.scheduleRemoval(sub);
    }

    this.connToSub.delete(connectionId);
  }

  /**
   * Dispatch an upstream subscription notification to the owning client.
   *
   * Listens for `upstream.notification` events emitted by {@link UpstreamService}.
   * Maps the Helius subscription ID back to the proxy ID, then forwards the
   * notification payload to the client, replacing the Helius ID with the
   * proxy ID so the client sees a stable identifier.
   */
  @OnEvent('upstream.notification')
  handleNotification(msg: { method: string; params: { subscription: number; result: unknown } }) {
    const heliusSubId = msg.params?.subscription;
    if (heliusSubId == null) return;

    const proxySubId = this.heliusIdToProxy.get(heliusSubId);
    if (!proxySubId) return;

    const sub = this.subs.get(proxySubId);
    if (!sub) return;

    this.clients.send(sub.connectionId, {
      jsonrpc: '2.0',
      method: msg.method,
      params: {
        subscription: proxySubId,
        result: msg.params.result,
      },
    });
  }

  /**
   * Re-subscribe all active subscriptions after the upstream WebSocket reconnects.
   *
   * Listens for `upstream.reconnected` events. Clears the old Helius-to-proxy
   * ID map (stale after reconnect), then iterates every tracked subscription:
   * - Subscriptions pending removal are torn down immediately.
   * - Active subscriptions are re-sent upstream and their ID mappings refreshed.
   *
   * This ensures clients experience no interruption across upstream reconnects.
   */
  @OnEvent('upstream.reconnected')
  async handleReconnected() {
    this.logger.log('Re-subscribing after upstream reconnect…');
    this.heliusIdToProxy.clear();

    for (const [proxySubId, sub] of this.subs) {
      // Skip subs pending removal
      if (sub.unsubscribeTimer) {
        clearTimeout(sub.unsubscribeTimer);
        sub.unsubscribeTimer = null;
        this.teardown(sub);
        continue;
      }

      sub.heliusSubId = null;

      const promise = this.upstream
        .sendRequest(sub.method, sub.params)
        .then((result) => {
          const heliusSubId = result as number;
          sub.heliusSubId = heliusSubId;
          sub.pendingPromise = null;
          this.heliusIdToProxy.set(heliusSubId, proxySubId);
          this.logger.log(`Re-subscribed: ${sub.method} → ${heliusSubId}`);
          return heliusSubId;
        })
        .catch((err) => {
          this.logger.error(`Re-subscribe failed for ${sub.method}: ${err}`);
          sub.pendingPromise = null;
          throw err;
        });

      sub.pendingPromise = promise;

      try {
        await promise;
      } catch {
        // Already logged above
      }
    }
  }

  get stats() {
    return {
      upstreamSubscriptions: this.subs.size,
      clientSubscriptions: this.subs.size,
      connections: this.connToSub.size,
    };
  }

  /**
   * Schedule a subscription for upstream teardown after the idle grace period.
   *
   * If the timer is already running (e.g. called twice for the same sub),
   * it is reset. When the timer fires, {@link teardown} sends the
   * unsubscribe RPC and removes all internal tracking state.
   */
  private scheduleRemoval(sub: Subscription) {
    if (sub.unsubscribeTimer) {
      clearTimeout(sub.unsubscribeTimer);
    }
    sub.unsubscribeTimer = setTimeout(() => {
      sub.unsubscribeTimer = null;
      this.teardown(sub);
    }, this.idleTimeoutMs);
  }

  /**
   * Immediately tear down a subscription.
   *
   * Clears any pending removal timer, removes internal tracking state,
   * and sends the corresponding unsubscribe RPC to Helius. If the
   * subscribe request is still in-flight, marks the subscription as
   * `cancelled` so the pending `.then()` handler cleans up instead.
   */
  private async teardown(sub: Subscription) {
    if (sub.unsubscribeTimer) {
      clearTimeout(sub.unsubscribeTimer);
      sub.unsubscribeTimer = null;
    }

    this.subs.delete(sub.proxySubId);

    // If still pending, mark cancelled — .then() will clean up
    if (sub.pendingPromise) {
      sub.cancelled = true;
      return;
    }

    const unsubMethod = UNSUB_METHOD[sub.method];
    if (sub.heliusSubId != null && unsubMethod) {
      this.heliusIdToProxy.delete(sub.heliusSubId);
      try {
        await this.upstream.sendRequest(unsubMethod, [sub.heliusSubId]);
        this.logger.log(`Unsubscribed upstream: ${unsubMethod}(${sub.heliusSubId})`);
      } catch (err) {
        this.logger.warn(`Upstream unsubscribe failed: ${err}`);
      }
    }
  }

  private removeSub(proxySubId: string) {
    const sub = this.subs.get(proxySubId);
    if (!sub) return;
    this.subs.delete(proxySubId);
    this.connToSub.delete(sub.connectionId);
  }
}
