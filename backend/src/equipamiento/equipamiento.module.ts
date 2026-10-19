import { Module } from '@nestjs/common';
import { EquipamientoController } from './equipamiento.controller';
import { EquipamientoService } from './equipamiento.service';

@Module({
  controllers: [EquipamientoController],
  providers: [EquipamientoService],
  exports: [EquipamientoService],
})
export class EquipamientoModule {}
