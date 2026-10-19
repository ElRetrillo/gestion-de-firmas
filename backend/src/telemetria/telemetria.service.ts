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
    const isDesconectado = dto.estadoHardware === EstadoHardwareEnum.DESCONECTADO;

    // 0. Consultar estado previo para distinguir transición real de hardware vs heartbeat periódico
    let previousState: string | null = await this.redis.getPresence(dto.codigoPc);
    let previousStation: any = null;
    try {
      previousStation = await this.prisma.estacionTrabajo.findUnique({
        where: { codigoPc: dto.codigoPc },
      });
      if (!previousState && previousStation) {
        previousState = previousStation.estadoHardware;
      }
    } catch {
      // Ignorar si BD no responde
    }

    const isHeartbeat = Boolean(dto.metadatos && dto.metadatos.isHeartbeat === true);
    const stateChanged =
      previousState !== dto.estadoHardware ||
      (!isDesconectado && dto.serialNumber && previousStation?.serialTokenActivo !== dto.serialNumber) ||
      !isHeartbeat;

    // 1. Persistencia en caché efímera de Redis (TTL 3600s)
    await this.redis.setPresence(dto.codigoPc, dto.estadoHardware);

    // 2. Registro o vinculación de hardware token si está presente
    let tokenId: string | null = null;
    let tokenInfo: {
      serialNumber?: string;
      vendorId?: string;
      marca?: string;
      modelo?: string;
    } | null = null;

    if (!isDesconectado && dto.serialNumber) {
      try {
        const token = await this.prisma.tokenHardware.upsert({
          where: { serialNumber: dto.serialNumber },
          update: {
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Thales / SafeNet',
            modelo: dto.modelo || 'USB Cryptographic Token',
          },
          create: {
            serialNumber: dto.serialNumber,
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Thales / SafeNet',
            modelo: dto.modelo || 'USB Cryptographic Token',
          },
        });
        tokenId = token.id;
        tokenInfo = {
          serialNumber: token.serialNumber,
          vendorId: token.vendorId,
          marca: token.marca,
          modelo: token.modelo,
        };
      } catch (err) {
        this.logger.warn(`No se pudo upsertar tokenHardware: ${(err as Error).message}`);
        tokenInfo = {
          serialNumber: dto.serialNumber,
          vendorId: dto.vendorId || 'UNKNOWN',
          marca: dto.marca || 'Thales / SafeNet',
          modelo: dto.modelo || 'USB Cryptographic Token',
        };
      }
    } else if (isDesconectado) {
      // Si se desconectó, buscar el token anterior solo para trazabilidad forense del evento de desconexión
      const prevSerial =
        (dto.metadatos?.previousSerialNumber as string | undefined) ||
        previousStation?.serialTokenActivo ||
        dto.serialNumber;
      if (prevSerial) {
        try {
          const prevToken = await this.prisma.tokenHardware.findUnique({
            where: { serialNumber: prevSerial },
          });
          if (prevToken) {
            tokenId = prevToken.id;
          }
        } catch {
          // Ignorar
        }
      }
      tokenInfo = null;
    }

    // 3. Upsert de la estación de trabajo (limpiando serialTokenActivo cuando pasa a DESCONECTADO)
    let estacionActualizada: any = null;
    try {
      estacionActualizada = await this.prisma.estacionTrabajo.upsert({
        where: { codigoPc: dto.codigoPc },
        update: {
          ultimoPing: timestamp,
          estadoHardware: dto.estadoHardware as any,
          serialTokenActivo: isDesconectado ? null : (dto.serialNumber ?? previousStation?.serialTokenActivo ?? null),
          ...(dto.ipAsignada ? { ipAsignada: dto.ipAsignada } : {}),
          ...(dto.dependenciaFisica ? { dependenciaFisica: dto.dependenciaFisica } : {}),
        },
        create: {
          codigoPc: dto.codigoPc,
          ipAsignada: dto.ipAsignada || '0.0.0.0',
          dependenciaFisica: dto.dependenciaFisica || 'Municipalidad de Coquimbo',
          ultimoPing: timestamp,
          estadoHardware: dto.estadoHardware as any,
          serialTokenActivo: isDesconectado ? null : (dto.serialNumber || null),
        },
      });
    } catch (err) {
      this.logger.warn(`No se pudo actualizar estación de trabajo: ${(err as Error).message}`);
    }

    // 4. Inserción en telemetria_eventos para auditoría forense solo ante cambios de estado o eventos explícitos
    if (stateChanged) {
      try {
        await this.prisma.telemetriaEvento.create({
          data: {
            codigoPc: dto.codigoPc,
            tokenId: tokenId,
            evento: dto.estadoHardware as any,
            timestamp: timestamp,
            metadatosJsonb: {
              ...((dto.metadatos as Record<string, unknown>) || {}),
              stateChanged: true,
              previousSerialNumber:
                (dto.metadatos?.previousSerialNumber as string | undefined) ||
                (isDesconectado ? previousStation?.serialTokenActivo : undefined),
            } as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        this.logger.warn(`No se pudo guardar telemetría forense en BD: ${(err as Error).message}`);
      }
    }

    // 5. Difusión en tiempo real vía WebSocket hacia Dashboard de Supervisores
    this.gateway.broadcastEstadoPc({
      codigoPc: dto.codigoPc,
      estadoHardware: dto.estadoHardware,
      timestamp: timestamp.toISOString(),
      ipAsignada: estacionActualizada?.ipAsignada || dto.ipAsignada || previousStation?.ipAsignada || '0.0.0.0',
      dependenciaFisica:
        estacionActualizada?.dependenciaFisica ||
        dto.dependenciaFisica ||
        previousStation?.dependenciaFisica ||
        'Municipalidad de Coquimbo',
      serialNumber: isDesconectado ? undefined : tokenInfo?.serialNumber,
      vendorId: isDesconectado ? undefined : tokenInfo?.vendorId,
      marca: isDesconectado ? undefined : tokenInfo?.marca,
      modelo: isDesconectado ? undefined : tokenInfo?.modelo,
      tokenInfo: isDesconectado ? null : tokenInfo,
      metadatos: {
        ...(dto.metadatos || {}),
        stateChanged,
        isHeartbeat: !stateChanged,
        previousSerialNumber:
          (dto.metadatos?.previousSerialNumber as string | undefined) ||
          (isDesconectado ? previousStation?.serialTokenActivo : undefined),
      },
    });

    this.logger.log(
      `Evento USB procesado: PC=${dto.codigoPc} Estado=${dto.estadoHardware} (${stateChanged ? 'CAMBIO_ESTADO' : 'HEARTBEAT'})`,
    );

    return {
      status: 'success',
      codigoPc: dto.codigoPc,
      estadoHardware: dto.estadoHardware,
      serialTokenActivo: isDesconectado ? null : tokenInfo?.serialNumber || null,
      stateChanged,
      timestamp: timestamp.toISOString(),
    };
  }

  async obtenerEstadosEstaciones() {
    let estaciones: any[] = [];
    let tokensMap: Record<string, any> = {};

    try {
      const [estRows, tokRows, ultimosEventos] = await Promise.all([
        this.prisma.estacionTrabajo.findMany({
          orderBy: { codigoPc: 'asc' },
        }),
        this.prisma.tokenHardware.findMany(),
        this.prisma.telemetriaEvento.findMany({
          take: 50,
          orderBy: { timestamp: 'desc' },
          include: { token: true },
        }),
      ]);
      estaciones = estRows;
      for (const t of tokRows) {
        tokensMap[t.serialNumber] = {
          serialNumber: t.serialNumber,
          vendorId: t.vendorId,
          marca: t.marca,
          modelo: t.modelo,
        };
      }
      // Respaldo por si una estación conectada no tenía serialTokenActivo poblado aún
      for (const ev of ultimosEventos) {
        if (ev.evento !== 'DESCONECTADO' && ev.token && !tokensMap[`__pc_${ev.codigoPc}`]) {
          tokensMap[`__pc_${ev.codigoPc}`] = {
            serialNumber: ev.token.serialNumber,
            vendorId: ev.token.vendorId,
            marca: ev.token.marca,
            modelo: ev.token.modelo,
          };
        }
      }
    } catch {
      estaciones = [];
    }

    const presencias = await this.redis.getAllPresences();

    return estaciones.map((estacion) => {
      const liveStatus = presencias[estacion.codigoPc] || estacion.estadoHardware;
      const isDesconectado = liveStatus === 'DESCONECTADO';

      let tokenInfo = null;
      if (!isDesconectado) {
        if (estacion.serialTokenActivo && tokensMap[estacion.serialTokenActivo]) {
          tokenInfo = tokensMap[estacion.serialTokenActivo];
        } else if (tokensMap[`__pc_${estacion.codigoPc}`]) {
          tokenInfo = tokensMap[`__pc_${estacion.codigoPc}`];
        }
      }

      return {
        ...estacion,
        serialTokenActivo: isDesconectado ? null : (estacion.serialTokenActivo || tokenInfo?.serialNumber || null),
        estadoEnVivo: liveStatus,
        tokenInfo: isDesconectado ? null : tokenInfo,
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

  async limpiarTelemetria() {
    await this.redis.clearAllPresences();
    try {
      await this.prisma.telemetriaEvento.deleteMany({});
      await this.prisma.estacionTrabajo.deleteMany({});
    } catch (err) {
      this.logger.warn(`Error al limpiar tablas de telemetría: ${(err as Error).message}`);
    }
    this.gateway.broadcastLimpiarMalla();
    return { status: 'cleared', timestamp: new Date().toISOString() };
  }
}
