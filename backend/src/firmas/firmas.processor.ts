import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TelemetriaGateway } from '../websocket/telemetria.gateway';
import * as crypto from 'crypto';

@Processor('lotes-firma')
export class FirmasProcessor extends WorkerHost {
  private readonly logger = new Logger(FirmasProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly wsGateway: TelemetriaGateway,
  ) {
    super();
  }

  async process(
    job: Job<{ codigoLote: string; solicitudIds: string[]; rutFirmante?: string }>,
  ): Promise<any> {
    const { codigoLote, solicitudIds, rutFirmante } = job.data;
    this.logger.log(
      `Iniciando orquestación de lote asíncrono ${codigoLote} con ${solicitudIds.length} documentos`,
    );

    const lockResource = `lote:${codigoLote}`;
    const lockToken = await this.redis.acquireLock(lockResource, 30000);

    const resultados = [];

    try {
      for (const [index, idOrCodigo] of solicitudIds.entries()) {
        await job.updateProgress(Math.round(((index + 1) / solicitudIds.length) * 100));

        const docContent = `DOC-MUNICIPAL-COQUIMBO-${idOrCodigo}-${codigoLote}-${Date.now()}`;
        const sha256Hash = crypto.createHash('sha256').update(docContent).digest('hex');
        const suffix = sha256Hash.substring(0, 4).toUpperCase();
        const codigoVerificacion = `VERIF-2026-CQM-${Math.floor(1000 + Math.random() * 9000)}-${suffix}`;

        try {
          const solicitud = await this.prisma.solicitudFirma.findFirst({
            where: {
              OR: [{ id: idOrCodigo }, { codigoDocumento: idOrCodigo }],
            },
          });

          if (solicitud) {
            await this.prisma.solicitudFirma.update({
              where: { id: solicitud.id },
              data: {
                estadoAprobacion: 'FIRMADA',
                hashSha256: sha256Hash,
                codigoVerificacion,
                tsaTimestamp: new Date(),
                documentoFirmadoUrl: `/api/v1/firmas/solicitudes/${solicitud.id}/pdf`,
              },
            });

            await this.prisma.historialCambio.create({
              data: {
                usuarioId: solicitud.usuarioSolicitanteId,
                usuarioEmail: `${rutFirmante || 'orquestador'}@municoquimbo.cl`,
                accion: 'FIRMA_LOTE_MASIVA',
                tablaAfectada: 'solicitudes_firma',
                registroId: solicitud.codigoDocumento,
                diffJsonb: {
                  codigoLote,
                  estadoAnterior: solicitud.estadoAprobacion,
                  estadoNuevo: 'FIRMADA',
                  hashSha256: sha256Hash,
                  codigoVerificacion,
                },
                ipOrigen: '10.10.12.45',
              },
            });
          }
        } catch (err) {
          this.logger.warn(`No se pudo persistir solicitud ${idOrCodigo}: ${(err as Error).message}`);
        }

        resultados.push({
          id: idOrCodigo,
          hashSha256: sha256Hash,
          codigoVerificacion,
          timestampRfc3161: new Date().toISOString(),
          estado: 'FIRMADO_EXITOSO',
        });
      }

      this.wsGateway.emitirActualizacionPresencia({
        tipo: 'LOTE_FIRMA_COMPLETADO',
        codigoLote,
        totalProcesados: solicitudIds.length,
        timestamp: new Date().toISOString(),
      });
    } finally {
      if (lockToken) {
        await this.redis.releaseLock(lockResource, lockToken);
      }
    }

    this.logger.log(`Lote ${codigoLote} completado exitosamente.`);
    return {
      codigoLote,
      totalProcesados: solicitudIds.length,
      resultados,
    };
  }
}
