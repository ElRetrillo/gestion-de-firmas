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

  @ApiPropertyOptional({ description: 'Contenido del archivo en Base64 (PDF/XML/JSON) enviado por API' })
  @IsString()
  @IsOptional()
  archivoBase64?: string;

  @ApiPropertyOptional({ description: 'Nombre original del archivo enviado', example: 'decreto-1420.pdf' })
  @IsString()
  @IsOptional()
  nombreArchivo?: string;

  @ApiPropertyOptional({ description: 'Content-Type según protocolo FirmaGob v2', example: 'application/pdf' })
  @IsString()
  @IsOptional()
  contentType?: string;

  @ApiPropertyOptional({ description: 'Checksum SHA-256 original del archivo' })
  @IsString()
  @IsOptional()
  checksum?: string;

  @ApiPropertyOptional({ description: 'Layout XML AgileSignerConfig para incrustar firma visible en PDF (Anexo B)' })
  @IsString()
  @IsOptional()
  layoutXml?: string;

  @ApiPropertyOptional({ description: 'Modalidad de firma: ATENDIDA (Propósito General con OTP/Token) o DESATENDIDA' })
  @IsString()
  @IsOptional()
  modalidadFirma?: 'ATENDIDA' | 'DESATENDIDA';
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

  @ApiPropertyOptional({ description: 'PIN criptográfico del token USB u OTP' })
  @IsString()
  @IsOptional()
  pin?: string;
}

export class FirmarSolicitudIndividualDto {
  @ApiProperty({ description: 'RUT del funcionario que firma o visa', example: '21.374.808-4' })
  @IsString()
  @IsNotEmpty()
  rutFirmante!: string;

  @ApiPropertyOptional({ description: 'PIN criptográfico o código OTP del Token (Requerido para Firma Atendida)', example: '1908' })
  @IsString()
  @IsOptional()
  pin?: string;

  @ApiPropertyOptional({ description: 'Código OTP cabecera FirmaGob v2 (para Firma Atendida - Propósito General)' })
  @IsString()
  @IsOptional()
  otp?: string;

  @ApiPropertyOptional({ description: 'Modalidad de firma: ATENDIDA (Propósito General) o DESATENDIDA', example: 'ATENDIDA' })
  @IsString()
  @IsOptional()
  modalidadFirma?: 'ATENDIDA' | 'DESATENDIDA';

  @ApiPropertyOptional({ description: 'Layout XML AgileSignerConfig (Anexo B) para incrustar firma en PDF' })
  @IsString()
  @IsOptional()
  layoutXml?: string;

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

export class IngestaArchivoFirmaApiDto {
  @ApiPropertyOptional({ description: 'RUT del funcionario destinatario que debe firmar el documento', example: '21.374.808-4' })
  @IsString()
  @IsOptional()
  rutDestinatario?: string;

  @ApiProperty({ description: 'Título o descripción del documento que llega por API', example: 'Resolución Exenta N° 408 - Recepción de Obras' })
  @IsString()
  @IsNotEmpty()
  tituloDocumento!: string;

  @ApiPropertyOptional({ description: 'Archivo en Base64 enviado desde el sistema o endpoint externo' })
  @IsString()
  @IsOptional()
  archivoBase64?: string;

  @ApiPropertyOptional({ description: 'Nombre original del archivo', example: 'resolucion-408.pdf' })
  @IsString()
  @IsOptional()
  nombreArchivo?: string;

  @ApiPropertyOptional({ description: 'Content-Type del archivo (application/pdf, application/xml, application/json)', example: 'application/pdf' })
  @IsString()
  @IsOptional()
  contentType?: string;

  @ApiPropertyOptional({ description: 'Hash SHA-256 original del archivo (checksum)' })
  @IsString()
  @IsOptional()
  checksum?: string;

  @ApiPropertyOptional({ description: 'Tipo de trámite municipal', example: 'RESOLUCION_EXENTA' })
  @IsString()
  @IsOptional()
  tipoTramite?: string;

  @ApiPropertyOptional({ description: 'Clasificación documental: PUBLICA | INTERNA | CONFIDENCIAL | CRITICA', example: 'INTERNA' })
  @IsString()
  @IsOptional()
  clasificacion?: string;

  @ApiPropertyOptional({ description: 'Sistema o servicio externo de origen', example: 'API_EXTERNA_MUNICIPAL' })
  @IsString()
  @IsOptional()
  sistemaOrigen?: string;

  @ApiPropertyOptional({ description: 'Indica si requiere visación posterior de Ministro de Fe' })
  @IsBoolean()
  @IsOptional()
  requiereFePublica?: boolean;

  @ApiPropertyOptional({ description: 'Modalidad sugerida: ATENDIDA (con OTP/Token) o DESATENDIDA', example: 'ATENDIDA' })
  @IsString()
  @IsOptional()
  modalidadFirma?: 'ATENDIDA' | 'DESATENDIDA';

  @ApiPropertyOptional({ description: 'Layout XML AgileSignerConfig (Anexo B) para incrustar firma en PDF' })
  @IsString()
  @IsOptional()
  layoutXml?: string;

  @ApiPropertyOptional({ description: 'Si es true, firma internamente en el mismo llamado y entrega listo para descargar' })
  @IsBoolean()
  @IsOptional()
  firmarInmediatamente?: boolean;

  @ApiPropertyOptional({ description: 'Código OTP o PIN si firmarInmediatamente=true en modalidad ATENDIDA' })
  @IsString()
  @IsOptional()
  otp?: string;
}

export class GenerarJwtFirmaGobDto {
  @ApiPropertyOptional({ description: 'RUN del titular sin puntos, sin guión ni dígito verificador', example: '11111111' })
  @IsString()
  @IsOptional()
  run?: string;

  @ApiPropertyOptional({ description: 'Nombre de la institución registrada en la RA', example: 'Subsecretaría General de la Presidencia' })
  @IsString()
  @IsOptional()
  entity?: string;

  @ApiPropertyOptional({ description: 'Propósito del certificado: "Propósito General" (Atendida) o "Desatendido"', example: 'Propósito General' })
  @IsString()
  @IsOptional()
  purpose?: string;

  @ApiPropertyOptional({ description: 'Fecha de expiración en hora chilena YYYY-MM-DDTHH:MM:SS (máx 30 min)' })
  @IsString()
  @IsOptional()
  expiration?: string;

  @ApiPropertyOptional({ description: 'Secreto simétrico HS256 (por defecto usa el de TEST: 27a216342c744f89b7b82fa290519ba0)' })
  @IsString()
  @IsOptional()
  secret?: string;
}

export class FirmaGobV2TicketsRequestDto {
  @ApiPropertyOptional({ description: 'JWT firmado en HS256 con entity, run, expiration, purpose' })
  @IsString()
  @IsOptional()
  token?: string;

  @ApiPropertyOptional({ description: 'Código único de aplicación registrado en la RA (en TEST: "sandbox")', example: 'sandbox' })
  @IsString()
  @IsOptional()
  api_token_key?: string;

  @ApiPropertyOptional({ description: 'Array de documentos a firmar según protocolo FirmaGob v2' })
  @IsArray()
  @IsOptional()
  files?: Array<{
    'content-type'?: string;
    contentType?: string;
    content?: string;
    description?: string;
    checksum?: string;
    layout?: string;
    references?: string[];
    xmlObjects?: string[];
  }>;

  @ApiPropertyOptional({ description: 'Modo de ejecución: SANDBOX_LOCAL (Motor Interno v2) o CERTIFICACION_GOB_CL (API Certificación Externa)' })
  @IsString()
  @IsOptional()
  modoConexion?: 'SANDBOX_LOCAL' | 'CERTIFICACION_GOB_CL';

  @ApiPropertyOptional({ description: 'ID de solicitud interna para vincular el resultado de la firma y habilitar descarga directa' })
  @IsString()
  @IsOptional()
  solicitudId?: string;
}
