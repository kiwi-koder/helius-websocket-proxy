import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';

/**
 * Registry of active client WebSocket connections.
 *
 * Maintains bidirectional mappings between connection UUIDs and WebSocket
 * instances. Other services use connection IDs to send messages without
 * holding direct references to WebSocket objects.
 */
@Injectable()
export class ClientConnectionService {
  private readonly logger = new Logger(ClientConnectionService.name);
  private readonly idToWs = new Map<string, WebSocket>();
  private readonly wsToId = new Map<WebSocket, string>();

  /** Assign a UUID to the WebSocket and store both mappings. */
  register(ws: WebSocket): string {
    const connectionId = randomUUID();
    this.idToWs.set(connectionId, ws);
    this.wsToId.set(ws, connectionId);
    return connectionId;
  }

  /** Look up the connection ID for a WebSocket instance. */
  getId(ws: WebSocket): string | undefined {
    return this.wsToId.get(ws);
  }

  /** Remove a connection by its ID. */
  remove(connectionId: string) {
    const ws = this.idToWs.get(connectionId);
    if (ws) {
      this.wsToId.delete(ws);
    }
    this.idToWs.delete(connectionId);
  }

  /** JSON-serialize and send a message to a client. No-ops if the socket is not open. */
  send(connectionId: string, data: unknown) {
    const ws = this.idToWs.get(connectionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      this.logger.error(`Failed to send to ${connectionId}: ${err}`);
    }
  }

  get size(): number {
    return this.idToWs.size;
  }
}
