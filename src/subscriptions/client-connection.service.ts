import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';

/**
 * Registry of active client WebSocket connections.
 *
 * Each connection is identified by a UUID assigned at connect time.
 * Other services use this to send messages to specific clients without
 * holding direct references to WebSocket instances.
 */
@Injectable()
export class ClientConnectionService {
  private readonly logger = new Logger(ClientConnectionService.name);
  private readonly connections = new Map<string, WebSocket>();

  /** Store a newly opened client WebSocket under its connection ID. */
  register(connectionId: string, ws: WebSocket) {
    this.connections.set(connectionId, ws);
  }

  /** Remove a client connection from the registry (called on disconnect). */
  remove(connectionId: string) {
    this.connections.delete(connectionId);
  }

  /** JSON-serialize and send a message to a client. No-ops if the socket is not open. */
  send(connectionId: string, data: unknown) {
    const ws = this.connections.get(connectionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      this.logger.error(`Failed to send to ${connectionId}: ${err}`);
    }
  }

  get size(): number {
    return this.connections.size;
  }
}
