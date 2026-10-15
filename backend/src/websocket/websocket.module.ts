import { Module, Global } from '@nestjs/common';
import { TelemetriaGateway } from './telemetria.gateway';

@Global()
@Module({
  providers: [TelemetriaGateway],
  exports: [TelemetriaGateway],
})
export class WebsocketModule {}
