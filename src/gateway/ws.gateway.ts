import { WebSocketGateway, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ClientConnectionService } from '../subscriptions/client-connection.service';
import { validateClientMessage } from './validation.util';
import { ServerErrorMessage } from './client-message.types';

/**
 * WebSocket gateway that accepts client connections on `/ws`.
 *
 * Each connecting client is assigned a UUID. Incoming messages are validated
 * and dispatched to {@link SubscriptionsService} for subscribe/unsubscribe
 * handling. Disconnections trigger subscription cleanup via the same service.
 */
@WebSocketGateway({
  path: '/ws'
})
export class WsProxyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(WsProxyGateway.name);
  private readonly wsToId = new Map<WebSocket, string>();

  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly clients: ClientConnectionService,
  ) {}

  /** Assign a UUID, register the socket, and wire up the message handler. */
  handleConnection(client: WebSocket) {
    const connectionId = randomUUID();
    this.wsToId.set(client, connectionId);
    this.clients.register(connectionId, client);
    this.logger.log(`Client connected: ${connectionId}`);

    client.on('message', (data: WebSocket.Data) => {
      this.handleRawMessage(client, data);
    });
  }

  /** Unregister the socket and notify SubscriptionsService of the disconnect. */
  handleDisconnect(client: WebSocket) {
    const connectionId = this.wsToId.get(client);
    if (!connectionId) return;
    this.wsToId.delete(client);
    this.clients.remove(connectionId);
    this.subscriptions.handleDisconnect(connectionId);
    this.logger.log(`Client disconnected: ${connectionId}`);
  }

  /** Parse, validate, and route an incoming client message to the appropriate action. */
  private async handleRawMessage(client: WebSocket, data: WebSocket.Data) {
    const connectionId = this.wsToId.get(client);
    if (!connectionId) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.sendError(connectionId, 'Invalid JSON');
      return;
    }

    const msg = validateClientMessage(parsed);
    if (!msg) {
      this.sendError(connectionId, 'Invalid message format');
      return;
    }

    if (msg.action === 'subscribe') {
      try {
        const subId = await this.subscriptions.subscribe(
          connectionId,
          msg.method,
          msg.params ?? [],
        );
        this.clients.send(connectionId, {
          type: 'subscribed',
          subscriptionId: subId,
          method: msg.method,
        });
      } catch (err) {
        this.sendError(connectionId, `Subscribe failed: ${err}`);
      }
      return;
    }

    if (msg.action === 'unsubscribe') {
      const ok = this.subscriptions.unsubscribe(msg.subscriptionId);
      if (ok) {
        this.clients.send(connectionId, {
          type: 'unsubscribed',
          subscriptionId: msg.subscriptionId,
        });
      } else {
        this.sendError(connectionId, 'Unknown subscription');
      }
    }
  }

  private sendError(connectionId: string, message: string) {
    const err: ServerErrorMessage = { type: 'error', message };
    this.clients.send(connectionId, err);
  }
}
