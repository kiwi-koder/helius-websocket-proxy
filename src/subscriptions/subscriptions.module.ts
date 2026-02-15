import { Module } from '@nestjs/common';
import { UpstreamModule } from '../upstream/upstream.module';
import { SubscriptionsService } from './subscriptions.service';
import { ClientConnectionService } from './client-connection.service';

@Module({
  imports: [UpstreamModule],
  providers: [SubscriptionsService, ClientConnectionService],
  exports: [SubscriptionsService, ClientConnectionService],
})
export class SubscriptionsModule {}
