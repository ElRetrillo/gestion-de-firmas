import { IsString, IsNotEmpty, IsOptional, IsArray, IsNumber, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CrearSolicitudFirmaDto {
  @ApiProperty({ description: 'RUT o ID del funcionario solicitante', example: '17.450.221-8' })
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

  @ApiPropertyOptional({ description: 'Resumen o materia administrativa' })
  @IsString()
  @IsOptional()
  resumenMateria?: string;

  @ApiPropertyOptional({ description: 'Clasificación documental' })
  @IsString()
  @IsOptional()
  clasificacion?: string;

  @ApiPropertyOptional({ description: 'Unidad municipal de origen' })
  @IsString()
  @IsOptional()
  unidadOrigen?: string;

  @ApiPropertyOptional({ description: 'Número de folios' })
  @IsNumber()
  @IsOptional()
  numeroFolios?: number;

  @ApiPropertyOptional({ description: 'Prioridad administrativa' })
  @IsString()
  @IsOptional()
  prioridad?: string;

  @ApiPropertyOptional({ description: 'Requiere atestación de Ministro de Fe' })
  @IsBoolean()
  @IsOptional()
  requiereFePublica?: boolean;

  @ApiPropertyOptional({ description: 'URL del documento original PDF en Object Storage', example: 'https://minio.coquimbo.cl/evidencias/decreto-1420.pdf' })
  @IsString()
  @IsOptional()
  documentoUrl?: string;

  @ApiPropertyOptional({ description: 'Flujo de visación jerárquica escalonada' })
  @IsArray()
  @IsOptional()
  flujoVisacion?: Array<{ rut: string; nombre?: string; cargo: string; estado: string; orden: number; fecha?: string | null }>;
}

export class CrearLoteFirmaDto {
  @ApiProperty({ description: 'Identificador del lote de firma masiva', example: 'BATCH-2026-10-DOM-01' })
  @IsString()
  @IsNotEmpty()
  codigoLote!: string;

  @ApiProperty({ description: 'Lista de IDs o códigos de solicitudes a firmar masivamente' })
  @IsArray()
  solicitudIds!: string[];

  @ApiPropertyOptional({ description: 'RUT del firmante o supervisor que ejecuta el lote' })
  @IsString()
  @IsOptional()
  rutFirmante?: string;

  @ApiPropertyOptional({ description: 'PIN criptográfico del token USB' })
  @IsString()
  @IsOptional()
  pin?: string;
}

export class FirmarSolicitudIndividualDto {
  @ApiProperty({ description: 'RUT del funcionario que firma o visa', example: '17.450.221-8' })
  @IsString()
  @IsNotEmpty()
  rutFirmante!: string;

  @ApiProperty({ description: 'PIN criptográfico de 6 dígitos del Token USB', example: '202604' })
  @IsString()
  @IsNotEmpty()
  pin!: string;

  @ApiPropertyOptional({ description: 'Acción: FIRMAR | VISAR | RECHAZAR', example: 'FIRMAR' })
  @IsString()
  @IsOptional()
  accion?: 'FIRMAR' | 'VISAR' | 'RECHAZAR';

  @ApiPropertyOptional({ description: 'Observación administrativa o causal de rechazo' })
  @IsString()
  @IsOptional()
  observacion?: string;
}

export class OtorgarFePublicaDto {
  @ApiProperty({ description: 'RUT del Ministro de Fe (Secretario Municipal)', example: '10.892.341-2' })
  @IsString()
  @IsNotEmpty()
  rutMinistro!: string;

  @ApiPropertyOptional({ description: 'PIN criptográfico del Ministro de Fe', example: '202603' })
  @IsString()
  @IsOptional()
  pin?: string;
}
