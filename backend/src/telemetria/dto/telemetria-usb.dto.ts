import { IsString, IsNotEmpty, IsEnum, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum EstadoHardwareEnum {
  DESCONECTADO = 'DESCONECTADO',
  CONECTADO = 'CONECTADO',
  FIRMANDO = 'FIRMANDO',
}

export class TelemetriaUsbDto {
  @ApiProperty({ description: 'Identificador / Hostname de la estación de trabajo', example: 'PC-SECMUN-02' })
  @IsString()
  @IsNotEmpty()
  codigoPc!: string;

  @ApiProperty({
    description: 'Estado físico del token criptográfico',
    enum: EstadoHardwareEnum,
    example: EstadoHardwareEnum.CONECTADO,
  })
  @IsEnum(EstadoHardwareEnum)
  estadoHardware!: EstadoHardwareEnum;

  @ApiPropertyOptional({ description: 'Número de serie del token USB', example: 'SN-987456123' })
  @IsString()
  @IsOptional()
  serialNumber?: string;

  @ApiPropertyOptional({ description: 'Vendor ID del dispositivo USB (SafeNet, ePass2003, Athena)', example: '0x04B9' })
  @IsString()
  @IsOptional()
  vendorId?: string;

  @ApiPropertyOptional({ description: 'Marca comercial del token', example: 'SafeNet / Gemalto' })
  @IsString()
  @IsOptional()
  marca?: string;

  @ApiPropertyOptional({ description: 'Modelo del token', example: 'eToken 5110' })
  @IsString()
  @IsOptional()
  modelo?: string;

  @ApiPropertyOptional({ description: 'Dirección IP de la estación', example: '10.20.4.15' })
  @IsString()
  @IsOptional()
  ipAsignada?: string;

  @ApiPropertyOptional({ description: 'Dependencia física municipal', example: 'Secretaría Municipal, Oficina 2' })
  @IsString()
  @IsOptional()
  dependenciaFisica?: string;

  @ApiPropertyOptional({ description: 'Timestamp ISO de la captura en el cliente Windows', example: '2026-10-15T12:30:00.000Z' })
  @IsString()
  @IsOptional()
  timestamp?: string;

  @ApiPropertyOptional({ description: 'Metadatos forenses en formato JSON', example: { os: 'Windows 11 Enterprise', appVersion: '1.2.0' } })
  @IsObject()
  @IsOptional()
  metadatos?: Record<string, unknown>;
}
