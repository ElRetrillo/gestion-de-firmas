import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CrearSolicitudFirmaDto {
  @ApiProperty({ description: 'RUT o ID del funcionario solicitante', example: '15.420.312-K' })
  @IsString()
  @IsNotEmpty()
  rutSolicitante!: string;

  @ApiProperty({ description: 'Tipo de trámite municipal', example: 'DECRETO_ALCALDICIO' })
  @IsString()
  @IsNotEmpty()
  tipoTramite!: string;

  @ApiProperty({ description: 'Título o materia del documento a firmar', example: 'Decreto N° 1420 - Aprobación Presupuestaria' })
  @IsString()
  @IsNotEmpty()
  tituloDocumento!: string;

  @ApiPropertyOptional({ description: 'URL del documento original PDF en Object Storage', example: 'https://minio.coquimbo.cl/evidencias/decreto-1420.pdf' })
  @IsString()
  @IsOptional()
  documentoUrl?: string;

  @ApiPropertyOptional({ description: 'Flujo de visación jerárquica escalonada' })
  @IsArray()
  @IsOptional()
  flujoVisacion?: Array<{ rut: string; cargo: string; estado: string; orden: number }>;
}

export class CrearLoteFirmaDto {
  @ApiProperty({ description: 'Identificador del lote de firma masiva', example: 'BATCH-2026-10-DOM-01' })
  @IsString()
  @IsNotEmpty()
  codigoLote!: string;

  @ApiProperty({ description: 'Lista de IDs de solicitudes a firmar masivamente' })
  @IsArray()
  solicitudIds!: string[];
}
