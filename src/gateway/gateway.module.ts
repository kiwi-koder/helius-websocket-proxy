import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { WsProxyGateway } from './ws.gateway';

@Module({
  imports: [SubscriptionsModule],
  providers: [WsProxyGateway],
})
export class GatewayModule {}
