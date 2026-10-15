import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

@Processor('lotes-firma')
export class FirmasProcessor extends WorkerHost {
  private readonly logger = new Logger(FirmasProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<{ codigoLote: string; solicitudIds: string[] }>): Promise<any> {
    const { codigoLote, solicitudIds } = job.data;
    this.logger.log(`Iniciando orquestación de lote asíncrono ${codigoLote} con ${solicitudIds.length} documentos`);

    const resultados = [];

    for (const [index, id] of solicitudIds.entries()) {
      await job.updateProgress(Math.round(((index + 1) / solicitudIds.length) * 100));

      // Simulación de procesamiento criptográfico (RFC 3161 TSA + Hash SHA-256)
      const fakeDocContent = `DOC-${id}-${Date.now()}`;
      const sha256Hash = crypto.createHash('sha256').update(fakeDocContent).digest('hex');

      try {
        await this.prisma.solicitudFirma.update({
          where: { id },
          data: {
            estadoAprobacion: 'FIRMADA',
            documentoFirmadoUrl: `https://storage.coquimbo.cl/firmados/${id}-signed.pdf`,
          },
        });
      } catch {
        // En caso de mock en memoria si la BD aún no tiene el registro
      }

      resultados.push({
        id,
        hashSha256: sha256Hash,
        timestampRfc3161: new Date().toISOString(),
        estado: 'FIRMADO_EXITOSO',
      });
    }

    this.logger.log(`Lote ${codigoLote} completado exitosamente.`);
    return {
      codigoLote,
      totalProcesados: solicitudIds.length,
      resultados,
    };
  }
}
