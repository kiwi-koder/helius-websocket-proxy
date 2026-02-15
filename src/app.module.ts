import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import envConfig from './config/env.config';
import { UpstreamModule } from './upstream/upstream.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { GatewayModule } from './gateway/gateway.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [envConfig] }),
    EventEmitterModule.forRoot(),
    UpstreamModule,
    SubscriptionsModule,
    GatewayModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
