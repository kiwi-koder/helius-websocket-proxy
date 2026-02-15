import { Module } from '@nestjs/common';
import { UpstreamService } from './upstream.service';

@Module({
  providers: [UpstreamService],
  exports: [UpstreamService],
})
export class UpstreamModule {}
