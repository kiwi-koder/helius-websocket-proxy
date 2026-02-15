import { Controller, Get } from '@nestjs/common';
import { UpstreamService } from '../upstream/upstream.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ClientConnectionService } from '../subscriptions/client-connection.service';

/** Simple health-check endpoint at `GET /health`. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly upstream: UpstreamService,
    private readonly subscriptions: SubscriptionsService,
    private readonly clients: ClientConnectionService,
  ) {}

  /** Return upstream connection status, client count, and subscription stats. */
  @Get()
  check() {
    return {
      status: 'ok',
      upstreamConnected: this.upstream.isConnected,
      connectedClients: this.clients.size,
      ...this.subscriptions.stats,
    };
  }
}
