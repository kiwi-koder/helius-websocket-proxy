import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manages the single upstream WebSocket connection to the Helius RPC.
 *
 * Handles connection lifecycle (connect, ping, reconnect with exponential
 * backoff) and multiplexes JSON-RPC requests/responses over the socket.
 * Subscription notifications are emitted as `upstream.notification` events
 * for {@link SubscriptionsService} to dispatch to clients.
 */
@Injectable()
export class UpstreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpstreamService.name);
  private ws: WebSocket | null = null;
  private rpcId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    this.connect();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('shutting down'));
    }
    this.pending.clear();
    this.ws?.close();
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a JSON-RPC request to Helius and return the parsed result.
   *
   * The request is assigned an auto-incrementing ID, serialized as JSON, and
   * written to the upstream socket. A 30-second timeout rejects the promise
   * if no response arrives.
   *
   * @param method - The JSON-RPC method name (e.g. `accountSubscribe`).
   * @param params - Positional parameters for the RPC call.
   * @returns The `result` field from the upstream JSON-RPC response.
   * @throws If the upstream socket is not open, the request times out, or
   *         the response contains an `error` field.
   */
  sendRequest(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('upstream not connected'));
      }
      const id = this.rpcId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`upstream timeout for rpc id ${id}`));
      }, 30_000);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /**
   * Open a new WebSocket to Helius, wire up event handlers, and start the
   * keepalive ping. On success, emits `upstream.reconnected` so that
   * {@link SubscriptionsService} can re-subscribe active subscriptions.
   */
  private connect() {
    if (this.destroyed) return;

    const apiKey = this.config.get<string>('HELIUS_API_KEY');
    const baseUrl = this.config.get<string>('HELIUS_WS_URL');
    const url = `${baseUrl}/?api-key=${apiKey}`;

    this.logger.log('Connecting to Helius upstream…');
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.logger.log('Upstream connected');
      this.reconnectAttempt = 0;
      this.startPing();
      this.events.emit('upstream.reconnected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        this.logger.error('Failed to parse upstream message', err);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.logger.warn(`Upstream closed: ${code} ${reason.toString()}`);
      this.stopPing();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error(`Upstream error: ${err.message}`);
    });
  }

  /**
   * Route an incoming upstream message to the correct handler.
   *
   * - Messages with a numeric `id` are JSON-RPC responses — resolve or
   *   reject the matching pending promise.
   * - Messages with a `method` string are subscription notifications —
   *   emit an `upstream.notification` event for fan-out to clients.
   */
  private handleMessage(msg: Record<string, unknown>) {
    // JSON-RPC response to our request
    if (msg.id != null && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    // Subscription notification
    if (msg.method && typeof msg.method === 'string') {
      this.events.emit('upstream.notification', msg);
    }
  }

  private startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30_000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Schedule a reconnection attempt using exponential backoff.
   *
   * Delay starts at 1 s and doubles each attempt, capped at 30 s.
   * Does nothing if the service has been destroyed (module shutdown).
   */
  private scheduleReconnect() {
    if (this.destroyed) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt++;
    this.logger.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
