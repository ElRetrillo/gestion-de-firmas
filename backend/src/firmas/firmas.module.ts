import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FirmasController, FirmaGobProtocoloController } from './firmas.controller';
import { FirmasService } from './firmas.service';
import { FirmasProcessor } from './firmas.processor';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'lotes-firma',
    }),
    AuthModule,
  ],
  controllers: [FirmasController, FirmaGobProtocoloController],
  providers: [FirmasService, FirmasProcessor],
  exports: [FirmasService],
})
export class FirmasModule {}
