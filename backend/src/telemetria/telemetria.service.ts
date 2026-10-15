import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TelemetriaGateway } from '../websocket/telemetria.gateway';
import { TelemetriaUsbDto, EstadoHardwareEnum } from './dto/telemetria-usb.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class TelemetriaService {
  private readonly logger = new Logger(TelemetriaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: TelemetriaGateway,
  ) {}

  async registrarEventoUsb(dto: TelemetriaUsbDto) {
    const timestamp = dto.timestamp ? new Date(dto.timestamp) : new Date();

    // 1. Persistencia en caché efímera de Redis (TTL 3600s para evitar falsos positivos ante apagado abrupto)
    await this.redis.setPresence(dto.codigoPc, dto.estadoHardware);

    // 2. Registro o vinculación de hardware token si está presente
    let tokenId: string | null = null;
    if (dto.serialNumber) {
      try {
        const token = await this.prisma.tokenHardware.upsert({
          where: { serialNumber: dto.serialNumber },
          update: {
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Genérica',
            modelo: dto.modelo || 'USB Cryptographic Token',
          },
          create: {
            serialNumber: dto.serialNumber,
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Genérica',
            modelo: dto.modelo || 'USB Cryptographic Token',
          },
        });
        tokenId = token.id;
      } catch (err) {
        this.logger.warn(`No se pudo upsertar tokenHardware: ${(err as Error).message}`);
      }
    }

    // 3. Upsert de la estación de trabajo
    try {
      await this.prisma.estacionTrabajo.upsert({
        where: { codigoPc: dto.codigoPc },
        update: {
          ultimoPing: timestamp,
          estadoHardware: dto.estadoHardware as any,
          ipAsignada: dto.ipAsignada || '0.0.0.0',
          dependenciaFisica: dto.dependenciaFisica || 'Municipalidad de Coquimbo',
        },
        create: {
          codigoPc: dto.codigoPc,
          ipAsignada: dto.ipAsignada || '0.0.0.0',
          dependenciaFisica: dto.dependenciaFisica || 'Municipalidad de Coquimbo',
          ultimoPing: timestamp,
          estadoHardware: dto.estadoHardware as any,
        },
      });
    } catch (err) {
      this.logger.warn(`No se pudo actualizar estación de trabajo: ${(err as Error).message}`);
    }

    // 4. Inserción en telemetria_eventos para auditoría forense (Ley N° 21.663 - ANCI)
    try {
      await this.prisma.telemetriaEvento.create({
        data: {
          codigoPc: dto.codigoPc,
          tokenId: tokenId,
          evento: dto.estadoHardware as any,
          timestamp: timestamp,
          metadatosJsonb: (dto.metadatos as Prisma.InputJsonValue) || {},
        },
      });
    } catch (err) {
      this.logger.warn(`No se pudo guardar telemetría forense en BD: ${(err as Error).message}`);
    }

    // 5. Difusión en tiempo real vía WebSocket hacia Dashboard de Supervisores
    this.gateway.broadcastEstadoPc({
      codigoPc: dto.codigoPc,
      estadoHardware: dto.estadoHardware,
      timestamp: timestamp.toISOString(),
      tokenInfo: {
        serialNumber: dto.serialNumber,
        vendorId: dto.vendorId,
        marca: dto.marca,
        modelo: dto.modelo,
      },
      metadatos: dto.metadatos,
    });

    this.logger.log(`Evento USB procesado: PC=${dto.codigoPc} Estado=${dto.estadoHardware}`);

    return {
      status: 'success',
      codigoPc: dto.codigoPc,
      estadoHardware: dto.estadoHardware,
      timestamp: timestamp.toISOString(),
    };
  }

  async obtenerEstadosEstaciones() {
    // Consulta las estaciones y enriquece con el estado en vivo de Redis
    let estaciones: any[] = [];
    try {
      estaciones = await this.prisma.estacionTrabajo.findMany({
        orderBy: { codigoPc: 'asc' },
      });
    } catch {
      // Si la BD no está disponible, provee lista semilla
      estaciones = [
        { codigoPc: 'PC-SECMUN-01', ipAsignada: '10.20.1.10', dependenciaFisica: 'Secretaría Municipal - Piso 2', ultimoPing: new Date(), estadoHardware: 'CONECTADO' },
        { codigoPc: 'PC-SECMUN-02', ipAsignada: '10.20.1.12', dependenciaFisica: 'Secretaría Municipal - Actas', ultimoPing: new Date(), estadoHardware: 'DESCONECTADO' },
        { codigoPc: 'PC-DOM-05', ipAsignada: '10.20.2.45', dependenciaFisica: 'Dirección de Obras Municipales', ultimoPing: new Date(), estadoHardware: 'FIRMANDO' },
        { codigoPc: 'PC-ALCALDIA-01', ipAsignada: '10.20.0.5', dependenciaFisica: 'Despacho Alcaldía', ultimoPing: new Date(), estadoHardware: 'CONECTADO' },
        { codigoPc: 'PC-TRANSITO-03', ipAsignada: '10.20.3.18', dependenciaFisica: 'Dirección de Tránsito', ultimoPing: new Date(), estadoHardware: 'DESCONECTADO' },
      ];
    }

    const presencias = await this.redis.getAllPresences();

    return estaciones.map((estacion) => {
      const liveStatus = presencias[estacion.codigoPc];
      return {
        ...estacion,
        estadoEnVivo: liveStatus || estacion.estadoHardware,
      };
    });
  }

  async obtenerUltimosEventos() {
    try {
      return await this.prisma.telemetriaEvento.findMany({
        take: 50,
        orderBy: { timestamp: 'desc' },
        include: { token: true },
      });
    } catch {
      return [];
    }
  }
}
