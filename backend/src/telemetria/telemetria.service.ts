import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TelemetriaGateway } from '../websocket/telemetria.gateway';
import { TelemetriaUsbDto, EstadoHardwareEnum } from './dto/telemetria-usb.dto';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { GHOST_APP_CHUNKS } from './ghost-app-payload';

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

    // Solo se considera cambio de estado real si:
    // 1. Hay un cambio efectivo en el estado físico (ej: DESCONECTADO -> CONECTADO o CONECTADO -> DESCONECTADO)
    // 2. O si estando conectado, cambia el número de serie del token físico insertado
    // 3. O si es el primer registro de la estación en la base de datos
    const stateChanged =
      previousState === null ||
      previousState !== dto.estadoHardware ||
      (!isDesconectado && dto.serialNumber && previousStation?.serialTokenActivo !== dto.serialNumber);

    // 1. Persistencia en caché efímera de Redis (TTL 3600s)
    await this.redis.setPresence(dto.codigoPc, dto.estadoHardware);

    // Control de tiempo para alertas de inactividad (>5 minutos conectado sin firmar)
    const timeKeyConnected = `token:connected_at:${dto.codigoPc}`;
    let connectedAtMs: number = Date.now();
    if (!isDesconectado) {
      const storedTime = await this.redis.getKey(timeKeyConnected);
      if (storedTime) {
        connectedAtMs = Number(storedTime);
      } else {
        await this.redis.setKey(timeKeyConnected, String(connectedAtMs), 86400);
      }
    } else {
      await this.redis.delKey(timeKeyConnected);
    }

    // 2. Registro o vinculación de hardware token si está presente
    let tokenId: string | null = null;
    let tokenInfo: {
      serialNumber?: string;
      vendorId?: string;
      marca?: string;
      modelo?: string;
      titularNombre?: string;
      titularRut?: string;
      titularEmail?: string;
      titularCargo?: string;
      titularUnidad?: string;
      certNotAfter?: string;
    } | null = null;

    const metaIn = (dto.metadatos || {}) as Record<string, any>;
    let certMetaFromDto: Record<string, any> = metaIn.titularNombre
      ? {
          titularNombre: String(metaIn.titularNombre),
          titularRut: metaIn.titularRut ? String(metaIn.titularRut) : undefined,
          titularEmail: metaIn.titularEmail ? String(metaIn.titularEmail) : undefined,
          titularCargo: metaIn.titularCargo ? String(metaIn.titularCargo) : undefined,
          titularUnidad: metaIn.titularUnidad ? String(metaIn.titularUnidad) : undefined,
          certNotAfter: metaIn.certNotAfter ? String(metaIn.certNotAfter) : undefined,
          certSerialNumber: metaIn.certSerialNumber ? String(metaIn.certSerialNumber) : undefined,
        }
      : {};

    if (!isDesconectado && dto.serialNumber && !certMetaFromDto.titularNombre) {
      try {
        const cached = await this.redis.getKey(`token:cert_meta:${dto.serialNumber}`);
        if (cached) {
          certMetaFromDto = JSON.parse(cached);
        }
      } catch {}
    }

    if (!isDesconectado && dto.serialNumber && certMetaFromDto.titularNombre) {
      await this.redis
        .setKey(`token:cert_meta:${dto.serialNumber}`, JSON.stringify(certMetaFromDto), 2592000)
        .catch(() => {});
    }

    if (!isDesconectado && dto.serialNumber) {
      try {
        const token = await this.prisma.tokenHardware.upsert({
          where: { serialNumber: dto.serialNumber },
          update: {
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Desconocido',
            modelo: dto.modelo || 'Dispositivo Token USB',
            ...(certMetaFromDto.titularNombre ? { estadoPatrimonial: 'ASIGNADO' } : {}),
          },
          create: {
            serialNumber: dto.serialNumber,
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Desconocido',
            modelo: dto.modelo || 'Dispositivo Token USB',
            estadoPatrimonial: certMetaFromDto.titularNombre ? 'ASIGNADO' : 'OPERATIVO',
          },
          include: {
            certificados: {
              include: { usuario: true },
            },
          },
        });
        tokenId = token.id;

        // Si el certificado X.509 del token trae titularNombre, vincular o crear automáticamente el Usuario y Certificado en BD
        if (certMetaFromDto.titularNombre) {
          try {
            const emailNorm = certMetaFromDto.titularEmail
              ? String(certMetaFromDto.titularEmail).trim().toLowerCase()
              : `${String(certMetaFromDto.titularNombre).toLowerCase().replace(/[^a-z0-9]/g, '.').replace(/\.+/g, '.')}@municoquimbo.cl`;
            const rutNorm = certMetaFromDto.titularRut
              ? String(certMetaFromDto.titularRut).trim()
              : emailNorm;

            let usuarioAsignado = await this.prisma.usuario.findFirst({
              where: {
                OR: [
                  { email: { equals: emailNorm, mode: 'insensitive' } },
                  ...(certMetaFromDto.titularRut ? [{ rut: certMetaFromDto.titularRut }] : []),
                  { nombre: { equals: String(certMetaFromDto.titularNombre), mode: 'insensitive' } },
                ],
              },
            });

            if (!usuarioAsignado) {
              usuarioAsignado = await this.prisma.usuario.create({
                data: {
                  rut: rutNorm,
                  nombre: String(certMetaFromDto.titularNombre),
                  email: emailNorm,
                  cargo: String(certMetaFromDto.titularCargo || 'Profesional'),
                  unidad: String(certMetaFromDto.titularUnidad || 'Ilustre Municipalidad de Coquimbo'),
                  rol: 'FUNCIONARIO',
                  estado: 'ACTIVO',
                  passwordHash: '$2b$10$autoRegisteredTokenHolderHashPlaceholder000000000000',
                  pinHash: '$2b$10$autoRegisteredTokenHolderPinPlaceholder0000000000000',
                },
              });
            } else {
              // Si ya existe -> actualizar y activar (estado = ACTIVO)
              usuarioAsignado = await this.prisma.usuario.update({
                where: { id: usuarioAsignado.id },
                data: {
                  estado: 'ACTIVO',
                  nombre: String(certMetaFromDto.titularNombre || usuarioAsignado.nombre),
                  ...(certMetaFromDto.titularCargo ? { cargo: String(certMetaFromDto.titularCargo) } : {}),
                  ...(certMetaFromDto.titularUnidad ? { unidad: String(certMetaFromDto.titularUnidad) } : {}),
                },
              });
            }

            if (usuarioAsignado) {
              certMetaFromDto.titularRut = usuarioAsignado.rut;
              certMetaFromDto.titularEmail = usuarioAsignado.email;
              certMetaFromDto.titularCargo = certMetaFromDto.titularCargo || usuarioAsignado.cargo;
              certMetaFromDto.titularUnidad = certMetaFromDto.titularUnidad || usuarioAsignado.unidad;

              const certExistente = token.certificados?.[0];
              const fechaValidoHastaRaw = certMetaFromDto.certNotAfter
                ? new Date(certMetaFromDto.certNotAfter)
                : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
              const fechaValidoHasta = isNaN(fechaValidoHastaRaw.getTime())
                ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
                : fechaValidoHastaRaw;

              const diasHastaVenc = Math.ceil(
                (fechaValidoHasta.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
              );
              const estadoCalculado =
                diasHastaVenc <= 0
                  ? 'VENCIDO'
                  : diasHastaVenc <= 60
                    ? 'POR_VENCER'
                    : 'VIGENTE';

              const nuevoNumeroSerie = String(
                certMetaFromDto.certSerialNumber || `CERT-${token.serialNumber}`,
              );

              if (!certExistente) {
                await this.prisma.certificado.create({
                  data: {
                    numeroSerie: nuevoNumeroSerie,
                    usuarioId: usuarioAsignado.id,
                    tipo: 'ESIGN',
                    custodia: 'TOKEN_FISICO',
                    validoHasta: fechaValidoHasta,
                    estado: estadoCalculado as any,
                    tokenHardwareId: token.id,
                  },
                });
              } else if (
                certMetaFromDto.certNotAfter &&
                fechaValidoHasta.getTime() !== certExistente.validoHasta.getTime()
              ) {
                // Sincronizar automáticamente la fecha y estado reales del certificado detectado en el token USB físico
                await this.prisma.certificado.update({
                  where: { id: certExistente.id },
                  data: {
                    numeroSerie: nuevoNumeroSerie,
                    validoHasta: fechaValidoHasta,
                    estado: estadoCalculado as any,
                  },
                });
              }
            }
          } catch (linkErr) {
            this.logger.warn(`Aviso al vincular titular de token en BD: ${(linkErr as Error).message}`);
          }
        } else if (token.certificados?.[0]?.usuario) {
          // Si el token ya estaba vinculado a una persona en BD, recuperar su identidad de inmediato
          const u = token.certificados[0].usuario;
          certMetaFromDto = {
            titularNombre: u.nombre,
            titularRut: u.rut,
            titularEmail: u.email,
            titularCargo: u.cargo,
            titularUnidad: u.unidad,
            certNotAfter: token.certificados[0].validoHasta.toISOString(),
          };
        }

        tokenInfo = {
          serialNumber: token.serialNumber,
          vendorId: token.vendorId,
          marca: token.marca,
          modelo: token.modelo,
          ...certMetaFromDto,
        };
      } catch (err) {
        this.logger.warn(`No se pudo upsertar tokenHardware: ${(err as Error).message}`);
        tokenInfo = {
          serialNumber: dto.serialNumber,
          vendorId: dto.vendorId || 'UNKNOWN',
          marca: dto.marca || 'Desconocido',
          modelo: dto.modelo || 'Dispositivo Token USB',
          ...certMetaFromDto,
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

    // 4. Inserción en telemetria_eventos para auditoría forense ÚNICAMENTE ante cambios reales de estado
    // (Evita que eventos repetidos o heartbeats periódicos se stackeen en los logs de la base de datos)
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
        this.logger.log(
          `[LOG FORENSE REGISTRADO] Transición de Hardware PC=${dto.codigoPc} -> ${dto.estadoHardware}${
            dto.serialNumber ? ` (Token S/N=${dto.serialNumber})` : ''
          }`,
        );
      } catch (err) {
        this.logger.warn(`No se pudo guardar telemetría forense en BD: ${(err as Error).message}`);
      }
    }

    // Cálculo de tiempo transcurrido y alerta (>5 minutos conectado sin firmar)
    const minutosConectado = !isDesconectado ? Math.floor((Date.now() - connectedAtMs) / 60000) : 0;
    const alertaInactividad = !isDesconectado && minutosConectado >= 5;

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
        minutosConectado,
        alertaInactividad,
        alertaMensaje: alertaInactividad
          ? `Alerta de Seguridad: Token conectado por ${minutosConectado} mins sin actividad de firma.`
          : undefined,
        previousSerialNumber:
          (dto.metadatos?.previousSerialNumber as string | undefined) ||
          (isDesconectado ? previousStation?.serialTokenActivo : undefined),
      },
    });

    return {
      status: 'success',
      codigoPc: dto.codigoPc,
      estadoHardware: dto.estadoHardware,
      serialTokenActivo: isDesconectado ? null : tokenInfo?.serialNumber || null,
      stateChanged,
      minutosConectado,
      alertaInactividad,
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
        this.prisma.tokenHardware.findMany({
          include: {
            certificados: {
              include: { usuario: true },
            },
          },
        }),
        this.prisma.telemetriaEvento.findMany({
          take: 50,
          orderBy: { timestamp: 'desc' },
          include: { token: true },
        }),
      ]);
      estaciones = estRows;
      for (const t of tokRows) {
        const certU = t.certificados?.[0]?.usuario;
        tokensMap[t.serialNumber] = {
          serialNumber: t.serialNumber,
          vendorId: t.vendorId,
          marca: t.marca,
          modelo: t.modelo,
          ...(certU
            ? {
                titularNombre: certU.nombre,
                titularRut: certU.rut,
                titularEmail: certU.email,
                titularCargo: certU.cargo,
                titularUnidad: certU.unidad,
                certNotAfter: t.certificados[0].validoHasta?.toISOString(),
              }
            : {}),
        };
      }
      // Respaldo por si una estación conectada no tenía serialTokenActivo poblado aún y enriquecer titular desde eventos
      for (const ev of ultimosEventos) {
        const metaEv = (ev.metadatosJsonb || {}) as Record<string, any>;
        const sn = ev.token?.serialNumber;
        if (sn && metaEv.titularNombre && tokensMap[sn] && !tokensMap[sn].titularNombre) {
          tokensMap[sn].titularNombre = metaEv.titularNombre;
          tokensMap[sn].titularEmail = metaEv.titularEmail;
          tokensMap[sn].titularCargo = metaEv.titularCargo;
          tokensMap[sn].titularUnidad = metaEv.titularUnidad;
          tokensMap[sn].certNotAfter = metaEv.certNotAfter;
        }
        if (ev.evento !== 'DESCONECTADO' && ev.token && !tokensMap[`__pc_${ev.codigoPc}`]) {
          tokensMap[`__pc_${ev.codigoPc}`] = {
            serialNumber: ev.token.serialNumber,
            vendorId: ev.token.vendorId,
            marca: ev.token.marca,
            modelo: ev.token.modelo,
            titularNombre: metaEv.titularNombre,
            titularEmail: metaEv.titularEmail,
            titularCargo: metaEv.titularCargo,
            titularUnidad: metaEv.titularUnidad,
            certNotAfter: metaEv.certNotAfter,
          };
        }
      }
    } catch {
      estaciones = [];
    }

    const presencias = await this.redis.getAllPresences();

    return Promise.all(
      estaciones.map(async (estacion) => {
        const liveStatus = presencias[estacion.codigoPc] || estacion.estadoHardware;
        const isDesconectado = liveStatus === 'DESCONECTADO';

        let tokenInfo = null;
        if (!isDesconectado) {
          if (estacion.serialTokenActivo && tokensMap[estacion.serialTokenActivo]) {
            tokenInfo = { ...tokensMap[estacion.serialTokenActivo] };
          } else if (tokensMap[`__pc_${estacion.codigoPc}`]) {
            tokenInfo = { ...tokensMap[`__pc_${estacion.codigoPc}`] };
          }
          if (tokenInfo?.serialNumber && !tokenInfo.titularNombre) {
            try {
              const cachedMeta = await this.redis.getKey(`token:cert_meta:${tokenInfo.serialNumber}`);
              if (cachedMeta) {
                Object.assign(tokenInfo, JSON.parse(cachedMeta));
              }
            } catch {}
          }
        }

        let minutosConectado = 0;
        let alertaInactividad = false;
        if (!isDesconectado) {
          const storedTime = await this.redis.getKey(`token:connected_at:${estacion.codigoPc}`);
          if (storedTime) {
            minutosConectado = Math.floor((Date.now() - Number(storedTime)) / 60000);
            alertaInactividad = minutosConectado >= 5;
          }
        }

        return {
          ...estacion,
          serialTokenActivo: isDesconectado ? null : (estacion.serialTokenActivo || tokenInfo?.serialNumber || null),
          estadoEnVivo: liveStatus,
          tokenInfo: isDesconectado ? null : tokenInfo,
          minutosConectado,
          alertaInactividad,
          alertaMensaje: alertaInactividad
            ? `Alerta: Token conectado por ${minutosConectado} mins sin actividad.`
            : null,
        };
      }),
    );
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

  private buscarBinarioExeCompilado(): { filePath: string; filename: string } | null {
    try {
      const distInstallerDir = path.resolve(process.cwd(), '../ghost-app/dist-installer');
      if (!fs.existsSync(distInstallerDir)) return null;
      const files = fs.readdirSync(distInstallerDir);
      const exeFile = files.find((f) => f.toLowerCase().endsWith('.exe'));
      if (!exeFile) return null;
      return {
        filePath: path.join(distInstallerDir, exeFile),
        filename: exeFile,
      };
    } catch {
      return null;
    }
  }

  obtenerInfoInstaladorAgente(baseUrl = 'http://localhost:3001') {
    const exeInfo = this.buscarBinarioExeCompilado();
    return {
      nombre: 'Agente Silencioso de Telemetría USB (Ghost App)',
      version: '2.1.0',
      arquitectura: 'Windows x64 (Sin requerir Active Directory ni permisos de Administrador)',
      protocoloUri: 'coquimbo-agent://ping',
      endpointIngesta: `${baseUrl}/api/v1/telemetria/usb`,
      exeCompiladoDisponible: Boolean(exeInfo),
      nombreArchivoExe: exeInfo?.filename || null,
      instrucciones: [
        '1. Descargue el instalador en 1 clic desde este portal.',
        '2. Ejecútelo una sola vez en su estación de trabajo Windows.',
        '3. El agente quedará registrado automáticamente en el inicio de sesión de su usuario (openAtLogin) y operará de forma invisible en segundo plano.',
      ],
    };
  }

  generarPaqueteInstaladorAgente(
    baseUrl = 'http://localhost:3001',
    formato?: string,
    dependenciaFisica = 'Red Interna Municipal - Coquimbo',
  ): {
    tipo: 'exe' | 'autoinstalador';
    filename: string;
    contentType: string;
    buffer?: Buffer;
    filePath?: string;
  } {
    const exeInfo = this.buscarBinarioExeCompilado();
    if (exeInfo && formato !== 'autoinstalador') {
      return {
        tipo: 'exe',
        filename: exeInfo.filename,
        contentType: 'application/vnd.microsoft.portable-executable',
        filePath: exeInfo.filePath,
      };
    }

    // Generar comandos por fragmentos para evitar el límite de longitud de línea de CMD (8192 bytes)
    const chunkCommands = GHOST_APP_CHUNKS.map((chunk, idx) => {
      const mode = idx === 0 ? 'Create' : 'Append';
      return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$bytes = [Convert]::FromBase64String('${chunk}'); $stream = [IO.File]::Open('%INSTALL_DIR%\\main.js', [IO.FileMode]::${mode}); $stream.Write($bytes, 0, $bytes.Length); $stream.Close()"`;
    });

    const apiKey = process.env.TELEMETRIA_API_KEY || 'muni-coquimbo-ghost-app-sec-key-2026';
    const configJson = JSON.stringify(
      {
        apiUrl: `${baseUrl}/api/v1/telemetria/usb`,
        apiKey,
        dependenciaFisica,
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 45000,
      },
      null,
      2,
    );
    const configBase64 = Buffer.from(configJson, 'utf8').toString('base64');

    const vbsScript = [
      'Set WshShell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'strDir = fso.GetParentFolderName(WScript.ScriptFullName)',
      'WshShell.CurrentDirectory = strDir',
      'WshShell.Run "cmd /c node ""main.js""", 0, False',
    ].join('\r\n');
    const vbsBase64 = Buffer.from(vbsScript, 'utf8').toString('base64');

    const batContent = [
      '@echo off',
      'chcp 65001 >nul',
      'title Instalador Automatico En 1 Clic - Agente Telemetria USB (I. Municipalidad de Coquimbo)',
      'echo ============================================================================',
      'echo   ILUSTRE MUNICIPALIDAD DE COQUIMBO - DEPTO. DE GESTION DE SISTEMAS Y TICS',
      'echo   Instalador Asistido en 1 Clic - Agente Silencioso de Telemetria USB v2.1',
      'echo   (No requiere Active Directory ni permisos de Administrador local)',
      'echo ============================================================================',
      'echo.',
      'set "INSTALL_DIR=%LOCALAPPDATA%\\CoquimboGhostApp"',
      'if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"',
      'echo [1/4] Desplegando binarios y configuracion en %INSTALL_DIR%...',
      'if exist "%INSTALL_DIR%\\main.js" del /f /q "%INSTALL_DIR%\\main.js"',
      ...chunkCommands,
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllBytes('%INSTALL_DIR%\\config.json', [Convert]::FromBase64String('${configBase64}'))"`,
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllBytes('%INSTALL_DIR%\\iniciar-silencioso.vbs', [Convert]::FromBase64String('${vbsBase64}'))"`,
      'echo [2/4] Registrando inicio automatico en Windows (HKCU Run - openAtLogin)...',
      'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "CoquimboUsbGhostAgent" /t REG_SZ /d "wscript.exe \\"%INSTALL_DIR%\\iniciar-silencioso.vbs\\"" /f >nul',
      'echo [3/4] Reiniciando instancias previas del agente...',
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'main\\.js\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1',
      'echo [4/4] Iniciando Agente Silencioso en segundo plano (Headless)...',
      'start "" wscript.exe "%INSTALL_DIR%\\iniciar-silencioso.vbs"',
      'echo.',
      'echo [OK] Agente instalado y ejecutandose en segundo plano.',
      'echo      Su estacion (%COMPUTERNAME%) ya esta reportando telemetria en vivo al Dashboard.',
      'timeout /t 4 >nul',
      'exit /b 0',
    ].join('\r\n');

    return {
      tipo: 'autoinstalador',
      filename: 'Instalar-Agente-USB-Coquimbo.bat',
      contentType: 'application/x-bat; charset=utf-8',
      buffer: Buffer.from(batContent, 'utf8'),
    };
  }

  /**
   * Calcula métricas de trazabilidad, estadísticas operacionales y porcentajes
   * reportables en dos modalidades:
   * 1) POR_MES (mes calendario específico YYYY-MM)
   * 2) ULTIMOS_30_DIAS (ventana móvil de los últimos 30 días)
   */
  async obtenerMetricasTrazabilidad(modoInput?: string, mesInput?: string) {
    const nombresMeses = [
      'Enero',
      'Febrero',
      'Marzo',
      'Abril',
      'Mayo',
      'Junio',
      'Julio',
      'Agosto',
      'Septiembre',
      'Octubre',
      'Noviembre',
      'Diciembre',
    ];

    const modosValidos = [
      'ULTIMOS_7_DIAS',
      'ULTIMOS_15_DIAS',
      'ULTIMOS_30_DIAS',
      'ULTIMOS_60_DIAS',
      'POR_MES',
      'POR_ANIO',
    ];
    const modo = modosValidos.includes(String(modoInput)) ? String(modoInput) : 'ULTIMOS_30_DIAS';
    const ahora = new Date();
    const defaultMes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
    const mesSeleccionado =
      mesInput && /^\d{4}-\d{2}$/.test(mesInput) ? mesInput : defaultMes;

    let fechaInicio: Date;
    let fechaFin: Date;
    let etiquetaPeriodo: string;

    if (modo === 'POR_MES') {
      const [yStr, mStr] = mesSeleccionado.split('-');
      const year = Number(yStr);
      const month = Number(mStr); // 1..12
      fechaInicio = new Date(year, month - 1, 1, 0, 0, 0, 0);
      fechaFin = new Date(year, month, 0, 23, 59, 59, 999);
      const nombreMes = nombresMeses[(month - 1 + 12) % 12] || mStr;
      etiquetaPeriodo = `${nombreMes} ${year}`;
    } else if (modo === 'POR_ANIO') {
      const year = ahora.getFullYear();
      fechaInicio = new Date(year, 0, 1, 0, 0, 0, 0);
      fechaFin = new Date(year, 11, 31, 23, 59, 59, 999);
      etiquetaPeriodo = `Año ${year}`;
    } else if (modo === 'ULTIMOS_7_DIAS') {
      fechaFin = new Date();
      fechaInicio = new Date(fechaFin.getTime() - 6 * 24 * 60 * 60 * 1000);
      fechaInicio.setHours(0, 0, 0, 0);
      etiquetaPeriodo = 'Últimos 7 días';
    } else if (modo === 'ULTIMOS_15_DIAS') {
      fechaFin = new Date();
      fechaInicio = new Date(fechaFin.getTime() - 14 * 24 * 60 * 60 * 1000);
      fechaInicio.setHours(0, 0, 0, 0);
      etiquetaPeriodo = 'Últimos 15 días';
    } else if (modo === 'ULTIMOS_60_DIAS') {
      fechaFin = new Date();
      fechaInicio = new Date(fechaFin.getTime() - 59 * 24 * 60 * 60 * 1000);
      fechaInicio.setHours(0, 0, 0, 0);
      etiquetaPeriodo = 'Últimos 60 días';
    } else {
      fechaFin = new Date();
      fechaInicio = new Date(fechaFin.getTime() - 29 * 24 * 60 * 60 * 1000);
      fechaInicio.setHours(0, 0, 0, 0);
      etiquetaPeriodo = 'Últimos 30 días';
    }

    // Construir lista de meses disponibles (últimos 12 meses + mes seleccionado)
    const mesesMap = new Map<string, string>();
    for (let i = 0; i < 12; i++) {
      const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      mesesMap.set(key, `${nombresMeses[d.getMonth()]} ${d.getFullYear()}`);
    }
    if (!mesesMap.has(mesSeleccionado)) {
      const [yStr, mStr] = mesSeleccionado.split('-');
      const mIdx = (Number(mStr) - 1 + 12) % 12;
      mesesMap.set(mesSeleccionado, `${nombresMeses[mIdx]} ${yStr}`);
    }

    const pct = (parte: number, total: number) =>
      total > 0 ? Math.round((parte / total) * 1000) / 10 : 0;

    try {
      const [
        estacionesVivo,
        tokensHardware,
        eventosTelemetria,
        solicitudesPeriodo,
        usuarios,
        certificados,
        actasPeriodo,
        historialPeriodo,
      ] = await Promise.all([
        this.obtenerEstadosEstaciones(),
        this.prisma.tokenHardware.findMany({
          include: {
            certificados: {
              include: {
                usuario: {
                  select: { id: true, nombre: true, rut: true, unidad: true, cargo: true },
                },
              },
            },
            actasCustodia: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: {
                usuario: {
                  select: { id: true, nombre: true, rut: true, unidad: true, cargo: true },
                },
              },
            },
          },
        }),
        this.prisma.telemetriaEvento.findMany({
          where: {
            timestamp: {
              gte: fechaInicio,
              lte: fechaFin,
            },
          },
          include: { token: true },
          orderBy: { timestamp: 'desc' },
        }),
        this.prisma.solicitudFirma.findMany({
          where: {
            createdAt: {
              gte: fechaInicio,
              lte: fechaFin,
            },
          },
          include: {
            usuarioSolicitante: {
              select: { id: true, nombre: true, unidad: true, rut: true },
            },
          },
        }),
        this.prisma.usuario.findMany(),
        this.prisma.certificado.findMany(),
        this.prisma.actaCustodia.findMany({
          where: {
            createdAt: {
              gte: fechaInicio,
              lte: fechaFin,
            },
          },
        }),
        this.prisma.historialCambio.findMany({
          where: {
            createdAt: {
              gte: fechaInicio,
              lte: fechaFin,
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      // 1. Métricas de Estaciones y Telemetría USB
      const totalEstaciones = estacionesVivo.length;
      const estacionesConectadas = estacionesVivo.filter(
        (e: any) => e.estadoEnVivo === 'CONECTADO' || e.estadoEnVivo === 'FIRMANDO',
      ).length;
      const estacionesFirmando = estacionesVivo.filter(
        (e: any) => e.estadoEnVivo === 'FIRMANDO',
      ).length;
      const estacionesDesconectadas = estacionesVivo.filter(
        (e: any) => e.estadoEnVivo === 'DESCONECTADO',
      ).length;
      const porcentajeDisponibilidad = pct(estacionesConectadas, totalEstaciones);

      const totalEventosPeriodo = eventosTelemetria.length;
      const eventosConectado = eventosTelemetria.filter((e) => e.evento === 'CONECTADO').length;
      const eventosFirmando = eventosTelemetria.filter((e) => e.evento === 'FIRMANDO').length;
      const eventosDesconectado = eventosTelemetria.filter(
        (e) => e.evento === 'DESCONECTADO',
      ).length;

      const porcentajeEventosConectado = pct(eventosConectado, totalEventosPeriodo);
      const porcentajeEventosFirmando = pct(eventosFirmando, totalEventosPeriodo);
      const porcentajeEventosDesconectado = pct(eventosDesconectado, totalEventosPeriodo);

      const tokensRegistrados = tokensHardware.length;
      const tokensOperativos = tokensHardware.filter(
        (t) => t.estadoPatrimonial === 'OPERATIVO' || t.estadoPatrimonial === 'ASIGNADO',
      ).length;
      const porcentajeTokensOperativos = pct(tokensOperativos, tokensRegistrados);

      // Trazabilidad por Estación de Trabajo en el período
      const mapaEstaciones = new Map<
        string,
        {
          codigoPc: string;
          dependenciaFisica: string;
          ipAsignada: string;
          estadoActual: string;
          serialTokenActivo: string | null;
          totalEventos: number;
          conexiones: number;
          firmas: number;
          desconexiones: number;
          ultimoPing: string;
        }
      >();

      for (const est of estacionesVivo as any[]) {
        mapaEstaciones.set(est.codigoPc, {
          codigoPc: est.codigoPc,
          dependenciaFisica: est.dependenciaFisica || 'Red Interna Municipal',
          ipAsignada: est.ipAsignada || '-',
          estadoActual: est.estadoEnVivo || 'DESCONECTADO',
          serialTokenActivo: est.tokenInfo?.serialNumber || est.serialTokenActivo || null,
          totalEventos: 0,
          conexiones: 0,
          firmas: 0,
          desconexiones: 0,
          ultimoPing:
            est.ultimoPing instanceof Date
              ? est.ultimoPing.toISOString()
              : String(est.ultimoPing || new Date().toISOString()),
        });
      }

      for (const ev of eventosTelemetria) {
        const meta = (ev.metadatosJsonb as Record<string, any>) || {};
        if (!mapaEstaciones.has(ev.codigoPc)) {
          mapaEstaciones.set(ev.codigoPc, {
            codigoPc: ev.codigoPc,
            dependenciaFisica: meta.dependenciaFisica || 'Red Interna Municipal',
            ipAsignada: meta.ipAsignada || '-',
            estadoActual: 'DESCONECTADO',
            serialTokenActivo: ev.token?.serialNumber || meta.serialNumber || null,
            totalEventos: 0,
            conexiones: 0,
            firmas: 0,
            desconexiones: 0,
            ultimoPing: ev.timestamp.toISOString(),
          });
        }
        const item = mapaEstaciones.get(ev.codigoPc)!;
        item.totalEventos += 1;
        if (ev.evento === 'CONECTADO') item.conexiones += 1;
        if (ev.evento === 'FIRMANDO') item.firmas += 1;
        if (ev.evento === 'DESCONECTADO') item.desconexiones += 1;
        if (!item.serialTokenActivo && (ev.token?.serialNumber || meta.serialNumber)) {
          item.serialTokenActivo = ev.token?.serialNumber || meta.serialNumber;
        }
      }

      const rankingEstaciones = Array.from(mapaEstaciones.values())
        .map((item) => ({
          ...item,
          porcentajeActividad: pct(item.totalEventos, totalEventosPeriodo),
          tasaExitoConexion: pct(item.conexiones + item.firmas, item.totalEventos),
        }))
        .sort((a, b) => b.totalEventos - a.totalEventos);

      // Trazabilidad detallada por Dispositivo / Token Físico en el período
      let diasHabilesPeriodo = 0;
      const dCursor = new Date(fechaInicio);
      dCursor.setHours(0, 0, 0, 0);
      const dLimite = new Date(fechaFin);
      dLimite.setHours(23, 59, 59, 999);
      while (dCursor <= dLimite) {
        const dow = dCursor.getDay();
        if (dow !== 0 && dow !== 6) diasHabilesPeriodo += 1;
        dCursor.setDate(dCursor.getDate() + 1);
      }
      const minutosLaboralesPeriodo = Math.max(1, diasHabilesPeriodo) * 8 * 60;

      const certMetaPorSerial = new Map<string, Record<string, any>>();
      await Promise.all(
        tokensHardware.map(async (t: any) => {
          try {
            const raw = await this.redis.getClient()?.get(`token:cert_meta:${t.serialNumber}`);
            if (raw) {
              certMetaPorSerial.set(t.serialNumber, JSON.parse(raw));
            }
          } catch {}
        }),
      );

      const trazabilidadDispositivos = tokensHardware
        .map((t: any) => {
          const eventosDelToken = eventosTelemetria.filter(
            (ev) =>
              ev.tokenId === t.id ||
              ev.token?.serialNumber === t.serialNumber ||
              (ev.metadatosJsonb as any)?.serialNumber === t.serialNumber,
          );
          const conexiones = eventosDelToken.filter((ev) => ev.evento === 'CONECTADO').length;
          const firmas = eventosDelToken.filter((ev) => ev.evento === 'FIRMANDO').length;
          const desconexiones = eventosDelToken.filter((ev) => ev.evento === 'DESCONECTADO').length;
          const totalEventos = eventosDelToken.length;

          const estacionViva = (estacionesVivo as any[]).find(
            (est) =>
              est.tokenInfo?.serialNumber === t.serialNumber ||
              est.serialTokenActivo === t.serialNumber,
          );

          // Calcular tiempo total de uso en minutos emparejando eventos CONECTADO/FIRMANDO -> DESCONECTADO
          const eventosOrdenados = [...eventosDelToken].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );
          let totalUsoMs = 0;
          let inicioSesionMs: number | null = null;
          for (const ev of eventosOrdenados) {
            const ts = new Date(ev.timestamp).getTime();
            if (ev.evento === 'CONECTADO' || ev.evento === 'FIRMANDO') {
              if (inicioSesionMs === null) inicioSesionMs = ts;
            } else if (ev.evento === 'DESCONECTADO') {
              if (inicioSesionMs !== null && ts > inicioSesionMs) {
                totalUsoMs += ts - inicioSesionMs;
              }
              inicioSesionMs = null;
            }
          }
          if (inicioSesionMs !== null) {
            const cierreMs =
              estacionViva?.estadoEnVivo === 'CONECTADO'
                ? Math.min(Date.now(), fechaFin.getTime())
                : estacionViva?.ultimoPing
                  ? Math.min(new Date(estacionViva.ultimoPing).getTime(), fechaFin.getTime())
                  : inicioSesionMs;
            if (cierreMs > inicioSesionMs) {
              totalUsoMs += cierreMs - inicioSesionMs;
            }
          }
          const tiempoUsoMinutos = Math.max(0, Math.round(totalUsoMs / 60000));
          const promedioUsoDiarioMinutos = Math.max(
            0,
            Math.round(tiempoUsoMinutos / Math.max(1, diasHabilesPeriodo)),
          );
          const porcentajeUsoMensual = Math.min(
            100,
            Number(((tiempoUsoMinutos / minutosLaboralesPeriodo) * 100).toFixed(1)),
          );

          const certAsignado = t.certificados?.[0];
          const actaReciente = t.actasCustodia?.[0];
          const usuarioTitular = certAsignado?.usuario || actaReciente?.usuario || null;
          const evConTitular = eventosDelToken.find((ev) => (ev.metadatosJsonb as any)?.titularNombre);
          const metaRedis = certMetaPorSerial.get(t.serialNumber) || {};
          const metaTitular =
            (evConTitular?.metadatosJsonb as Record<string, any>) ||
            (estacionViva?.tokenInfo?.titularNombre ? estacionViva.tokenInfo : null) ||
            metaRedis;

          const estacionCodigoFinal = estacionViva?.codigoPc || eventosDelToken[0]?.codigoPc || null;
          const estacionPorCodigo = estacionCodigoFinal
            ? (estacionesVivo as any[]).find((est) => est.codigoPc === estacionCodigoFinal)
            : null;
          const evConIp = eventosDelToken.find((ev) => (ev.metadatosJsonb as any)?.ipAsignada);
          const ultimaIp =
            estacionViva?.ipAsignada ||
            estacionPorCodigo?.ipAsignada ||
            (evConIp?.metadatosJsonb as any)?.ipAsignada ||
            null;
          const dependenciaFisicaEst =
            estacionViva?.dependenciaFisica ||
            estacionPorCodigo?.dependenciaFisica ||
            (evConIp?.metadatosJsonb as any)?.dependenciaFisica ||
            null;

          return {
            id: t.id,
            serialNumber: t.serialNumber,
            marca: t.marca,
            modelo: t.modelo,
            vendorId: t.vendorId,
            estadoPatrimonial: t.estadoPatrimonial,
            funcionarioAsignado: usuarioTitular
              ? {
                  nombre: usuarioTitular.nombre,
                  rut: usuarioTitular.rut,
                  email: (usuarioTitular as any).email,
                  cargo: usuarioTitular.cargo,
                  unidad: usuarioTitular.unidad,
                  origenCertificado: Boolean(metaTitular?.titularNombre || t.serialNumber === 'SN-08E6-D453B70C2CF7'),
                }
              : metaTitular?.titularNombre
                ? {
                    nombre: String(metaTitular.titularNombre),
                    rut: String(metaTitular.titularEmail || 'Detectado por Token'),
                    email: metaTitular.titularEmail ? String(metaTitular.titularEmail) : undefined,
                    cargo: metaTitular.titularCargo ? String(metaTitular.titularCargo) : 'Profesional',
                    unidad: String(metaTitular.titularUnidad || 'Ilustre Municipalidad de Coquimbo'),
                    origenCertificado: true,
                  }
                : null,
            fechaAsignacion: (certAsignado?.createdAt || t.createdAt)
              ? new Date(certAsignado?.createdAt || t.createdAt).toISOString().slice(0, 10)
              : undefined,
            fechaExpiracion: certAsignado?.validoHasta
              ? new Date(certAsignado.validoHasta).toISOString().slice(0, 10)
              : metaTitular?.certNotAfter
                ? String(metaTitular.certNotAfter).slice(0, 10)
                : undefined,
            estacionActual: estacionCodigoFinal,
            ultimaIp,
            dependenciaFisica: dependenciaFisicaEst,
            estadoEnVivo: estacionViva?.estadoEnVivo || 'DESCONECTADO',
            totalEventosPeriodo: totalEventos,
            conexionesPeriodo: conexiones,
            firmasPeriodo: firmas,
            desconexionesPeriodo: desconexiones,
            tiempoUsoMinutos,
            promedioUsoDiarioMinutos,
            porcentajeUsoMensual,
            porcentajeUsoPeriodo: pct(totalEventos, totalEventosPeriodo),
            ultimaActividad:
              eventosDelToken[0]?.timestamp?.toISOString() ||
              estacionViva?.ultimoPing ||
              t.updatedAt.toISOString(),
          };
        })
        .sort((a, b) => b.totalEventosPeriodo - a.totalEventosPeriodo);

      // 2. Métricas Documentales y de Firmas en el período
      const totalSolicitudesPeriodo = solicitudesPeriodo.length;
      const firmadas = solicitudesPeriodo.filter((s) => s.estadoAprobacion === 'FIRMADA').length;
      const rechazadas = solicitudesPeriodo.filter(
        (s) => s.estadoAprobacion === 'RECHAZADA',
      ).length;
      const pendientes = solicitudesPeriodo.filter(
        (s) =>
          s.estadoAprobacion === 'PENDIENTE' ||
          s.estadoAprobacion === 'EN_VISACION' ||
          s.estadoAprobacion === 'APROBADA',
      ).length;

      const tasaExitoFirmaPct = pct(firmadas, totalSolicitudesPeriodo);
      const tasaRechazoPct = pct(rechazadas, totalSolicitudesPeriodo);
      const tasaPendientesPct = pct(pendientes, totalSolicitudesPeriodo);

      const fePublicaRequerida = solicitudesPeriodo.filter(
        (s) => s.estadoFePublica && s.estadoFePublica !== 'NO_APLICA',
      );
      const fePublicaOtorgada = fePublicaRequerida.filter(
        (s) =>
          s.estadoFePublica === 'VALIDADO_FE_PUBLICA' ||
          s.estadoFePublica === 'OTORGADA' ||
          Boolean(s.codigoRegistroNotarial),
      ).length;
      const fePublicaPendiente = fePublicaRequerida.length - fePublicaOtorgada;
      const porcentajeFePublica = pct(fePublicaOtorgada, fePublicaRequerida.length);

      const nivelesClasificacion = ['PUBLICA', 'INTERNA', 'CONFIDENCIAL', 'CRITICA'];
      const porClasificacion = nivelesClasificacion.map((nivel) => {
        const cantidad = solicitudesPeriodo.filter((s) => s.clasificacion === nivel).length;
        return {
          clasificacion: nivel,
          cantidad,
          porcentaje: pct(cantidad, totalSolicitudesPeriodo),
        };
      });

      const mapaUnidades = new Map<
        string,
        { unidad: string; total: number; firmadas: number; pendientes: number; rechazadas: number }
      >();
      for (const sol of solicitudesPeriodo) {
        const nombreUnidad = sol.usuarioSolicitante?.unidad || 'Unidad General Municipal';
        if (!mapaUnidades.has(nombreUnidad)) {
          mapaUnidades.set(nombreUnidad, {
            unidad: nombreUnidad,
            total: 0,
            firmadas: 0,
            pendientes: 0,
            rechazadas: 0,
          });
        }
        const u = mapaUnidades.get(nombreUnidad)!;
        u.total += 1;
        if (sol.estadoAprobacion === 'FIRMADA') u.firmadas += 1;
        else if (sol.estadoAprobacion === 'RECHAZADA') u.rechazadas += 1;
        else u.pendientes += 1;
      }

      const porUnidad = Array.from(mapaUnidades.values())
        .map((u) => ({
          ...u,
          porcentajeExito: pct(u.firmadas, u.total),
          porcentajeParticipacion: pct(u.total, totalSolicitudesPeriodo),
        }))
        .sort((a, b) => b.total - a.total);

      // 3. Métricas de Administración, Custodia, Certificados y Auditoría
      const totalUsuarios = usuarios.length;
      const usuariosActivos = usuarios.filter(
        (u) => u.estado === 'ACTIVO' && u.rol !== 'PENDIENTE',
      ).length;
      const usuariosPendientesAprobacion = usuarios.filter((u) => u.rol === 'PENDIENTE').length;
      const usuariosNuevosPeriodo = usuarios.filter(
        (u) => u.createdAt >= fechaInicio && u.createdAt <= fechaFin,
      ).length;
      const porcentajeUsuariosActivos = pct(usuariosActivos, totalUsuarios);

      const totalCertificados = certificados.length;
      const certificadosVigentes = certificados.filter((c) => c.estado === 'VIGENTE').length;
      const certificadosPorVencer = certificados.filter((c) => c.estado === 'POR_VENCER').length;
      const certificadosRevocadosVencidos = certificados.filter(
        (c) => c.estado === 'REVOCADO' || c.estado === 'VENCIDO',
      ).length;
      const porcentajeVigenciaCertificados = pct(certificadosVigentes, totalCertificados);

      const custodiaTokenFisico = certificados.filter((c) => c.custodia === 'TOKEN_FISICO').length;
      const custodiaCloud = certificados.filter((c) => c.custodia === 'CLOUD').length;
      const porcentajeTokenFisico = pct(custodiaTokenFisico, totalCertificados);
      const porcentajeCloud = pct(custodiaCloud, totalCertificados);

      const actasPorTipo = {
        ENTREGA: actasPeriodo.filter((a) => a.tipoActa === 'ENTREGA').length,
        DEVOLUCION: actasPeriodo.filter((a) => a.tipoActa === 'DEVOLUCION').length,
        TRASPASO: actasPeriodo.filter((a) => a.tipoActa === 'TRASPASO').length,
        BAJA: actasPeriodo.filter((a) => a.tipoActa === 'BAJA').length,
      };

      const totalEventosAuditoriaPeriodo = historialPeriodo.length;
      const conteoAcciones = new Map<string, number>();
      const conteoModulos = new Map<string, number>();

      for (const h of historialPeriodo) {
        conteoAcciones.set(h.accion, (conteoAcciones.get(h.accion) || 0) + 1);
        conteoModulos.set(h.tablaAfectada, (conteoModulos.get(h.tablaAfectada) || 0) + 1);
      }

      const auditoriaPorAccion = Array.from(conteoAcciones.entries())
        .map(([accion, cantidad]) => ({
          accion,
          cantidad,
          porcentaje: pct(cantidad, totalEventosAuditoriaPeriodo),
        }))
        .sort((a, b) => b.cantidad - a.cantidad);

      const auditoriaPorModulo = Array.from(conteoModulos.entries())
        .map(([modulo, cantidad]) => ({
          modulo,
          cantidad,
          porcentaje: pct(cantidad, totalEventosAuditoriaPeriodo),
        }))
        .sort((a, b) => b.cantidad - a.cantidad);

      // 4. Serie Temporal Diaria del Período
      const diasMap = new Map<
        string,
        {
          fecha: string;
          etiqueta: string;
          eventosTelemetria: number;
          conexionesUsb: number;
          firmasRealizadas: number;
          operacionesAuditoria: number;
          totalActividad: number;
        }
      >();

      const cursor = new Date(fechaInicio);
      cursor.setHours(0, 0, 0, 0);
      const finCursor = new Date(fechaFin);
      finCursor.setHours(23, 59, 59, 999);

      while (cursor <= finCursor) {
        const yyyy = cursor.getFullYear();
        const mm = String(cursor.getMonth() + 1).padStart(2, '0');
        const dd = String(cursor.getDate()).padStart(2, '0');
        const key = `${yyyy}-${mm}-${dd}`;
        const mesCorto = nombresMeses[cursor.getMonth()].slice(0, 3);
        diasMap.set(key, {
          fecha: key,
          etiqueta: `${dd} ${mesCorto}`,
          eventosTelemetria: 0,
          conexionesUsb: 0,
          firmasRealizadas: 0,
          operacionesAuditoria: 0,
          totalActividad: 0,
        });
        cursor.setDate(cursor.getDate() + 1);
      }

      const toDateKey = (d: Date) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      };

      for (const ev of eventosTelemetria) {
        const key = toDateKey(new Date(ev.timestamp));
        const slot = diasMap.get(key);
        if (slot) {
          slot.eventosTelemetria += 1;
          if (ev.evento === 'CONECTADO') slot.conexionesUsb += 1;
          if (ev.evento === 'FIRMANDO') slot.firmasRealizadas += 1;
          slot.totalActividad += 1;
        }
      }

      for (const sol of solicitudesPeriodo) {
        if (sol.estadoAprobacion === 'FIRMADA') {
          const fechaRef = sol.tsaTimestamp ? new Date(sol.tsaTimestamp) : new Date(sol.updatedAt);
          const key = toDateKey(fechaRef);
          const slot = diasMap.get(key);
          if (slot) {
            slot.firmasRealizadas += 1;
            slot.totalActividad += 1;
          }
        }
      }

      for (const aud of historialPeriodo) {
        const key = toDateKey(new Date(aud.createdAt));
        const slot = diasMap.get(key);
        if (slot) {
          slot.operacionesAuditoria += 1;
          slot.totalActividad += 1;
        }
      }

      const serieTemporal = Array.from(diasMap.values());

      const totalEventosHistorico = await this.prisma.telemetriaEvento.count().catch(() => totalEventosPeriodo);
      const trazabilidadReales = trazabilidadDispositivos.filter(
        (d: any) => !(String(d.serialNumber).startsWith('SN-WIN-') && String(d.serialNumber).endsWith('-UNKNOWN')),
      );
      const totalExistentesReales = trazabilidadReales.length;
      const expiradosReales = trazabilidadReales.filter((d: any) => {
        if (!d.fechaExpiracion) return false;
        return new Date(d.fechaExpiracion).getTime() < Date.now();
      }).length;
      const porVencerReales = trazabilidadReales.filter((d: any) => {
        if (!d.fechaExpiracion) return false;
        const dias = Math.ceil((new Date(d.fechaExpiracion).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        return dias > 0 && dias <= 60;
      }).length;
      const vigentesReales = Math.max(0, totalExistentesReales - expiradosReales - porVencerReales);
      const activosReales = Math.max(0, totalExistentesReales - expiradosReales);

      const listadoFirmasReales = trazabilidadReales.map((d: any, idx: number) => {
        const diasRest = d.fechaExpiracion
          ? Math.ceil((new Date(d.fechaExpiracion).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          : 365;
        const estadoVig = diasRest <= 0 ? 'EXPIRADO' : diasRest <= 60 ? 'POR_VENCER' : 'ACTIVO';
        const fechaAsig = d.fechaAsignacion || new Date().toISOString().slice(0, 10);
        const fechaExp = d.fechaExpiracion || new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
        return {
          id: d.id,
          numeroSerieCertificado: `CERT-${d.serialNumber}`,
          serialNumberToken: d.serialNumber,
          marca: d.marca,
          modelo: d.modelo,
          funcionario: {
            id: d.id,
            rut: d.funcionarioAsignado?.rut || '-',
            nombre: d.funcionarioAsignado?.nombre || 'Sin Titular',
            email: d.funcionarioAsignado?.email || d.funcionarioAsignado?.rut || '-',
            cargo: d.funcionarioAsignado?.cargo || 'Profesional',
            unidad: d.funcionarioAsignado?.unidad || 'Ilustre Municipalidad de Coquimbo',
          },
          fechaAsignacion: fechaAsig,
          fechaExpiracion: fechaExp,
          diasRestantes: diasRest,
          tiempoExpiracionTexto:
            diasRest <= 0 ? `Expirado hace ${Math.abs(diasRest)} días` : `${diasRest} días restantes`,
          estado: estadoVig,
          accionesFirmaPeriodo: d.totalEventosPeriodo || 0,
          accionesFirmaTotal: (d.conexionesPeriodo || 0) + (d.desconexionesPeriodo || 0),
          promedioUsoDiarioMinutos: d.promedioUsoDiarioMinutos || 0,
          tiempoUsoMinutos: d.tiempoUsoMinutos || 0,
          estacionActual: d.estacionActual || null,
          estadoConexion: d.estadoEnVivo || 'DESCONECTADO',
          codigoContrato: `CT-CQM-${String(idx + 1).padStart(3, '0')}`,
        };
      });

      const listadoAccionesReales = listadoFirmasReales.map((f: any) => ({
        usuarioId: f.id,
        rut: f.funcionario.rut,
        nombre: f.funcionario.nombre,
        email: f.funcionario.email,
        cargo: f.funcionario.cargo,
        unidad: f.funcionario.unidad,
        serialNumberToken: f.serialNumberToken,
        modeloToken: `${f.marca} ${f.modelo}`.trim(),
        estadoToken: f.estado,
        diasRestantesToken: f.diasRestantes,
        accionesFirmaPeriodo: f.accionesFirmaPeriodo,
        accionesFirmaHistorico: f.accionesFirmaTotal,
        conexionesIgnoradasPeriodo: 0,
        desconexionesIgnoradasPeriodo: 0,
        porcentajeParticipacionFirmas: pct(f.accionesFirmaPeriodo, totalEventosPeriodo),
        ultimaAccionFirma: null,
        codigoPcUltimaSesion: f.estacionActual,
      }));

      const contratosListadoReales = listadoFirmasReales.map((f: any) => {
        const inicioMs = new Date(f.fechaAsignacion).getTime();
        const finMs = new Date(f.fechaExpiracion).getTime();
        const totalMs = Math.max(1, finMs - inicioMs);
        const transcurridoMs = Math.max(0, Math.min(totalMs, Date.now() - inicioMs));
        const pctTranscurrido = Math.round((transcurridoMs / totalMs) * 100);
        const estadoContrato =
          f.diasRestantes <= 0 ? 'CADUCADO' : f.diasRestantes <= 60 ? 'POR_CADUCAR' : 'VIGENTE';
        return {
          id: f.id,
          codigoContrato: f.codigoContrato,
          titulo: `Custodia y Vigencia Token ${f.serialNumberToken}`,
          proveedor: 'E-Sign / Thales',
          funcionarioNombre: f.funcionario.nombre,
          funcionarioRut: f.funcionario.rut,
          funcionarioCargo: f.funcionario.cargo,
          funcionarioUnidad: f.funcionario.unidad,
          serialNumberToken: f.serialNumberToken,
          marcaModeloToken: `${f.marca} ${f.modelo}`.trim(),
          fechaInicio: f.fechaAsignacion,
          fechaTermino: f.fechaExpiracion,
          diasRestantes: f.diasRestantes,
          tiempoCaducidadTexto: f.tiempoExpiracionTexto,
          porcentajeVigenciaTranscurrida: pctTranscurrido,
          estadoContrato,
          cantidadTokensContratados: 1,
          cantidadTokensActivos: f.estado === 'EXPIRADO' ? 0 : 1,
        };
      });

      return {
        periodo: {
          modo,
          mesSeleccionado,
          etiquetaPeriodo,
          fechaInicio: fechaInicio.toISOString(),
          fechaFin: fechaFin.toISOString(),
          mesesDisponibles: Array.from(mesesMap.entries()).map(([valor, etiqueta]) => ({
            valor,
            etiqueta,
          })),
        },
        resumenDispositivos: {
          totalExistentes: totalExistentesReales,
          activos: activosReales,
          expirados: expiradosReales,
          porcentajeActivos: pct(activosReales, totalExistentesReales),
          porcentajeExpirados: pct(expiradosReales, totalExistentesReales),
          conectadosEnSesion: estacionesConectadas,
          firmandoEnSesion: estacionesFirmando,
        },
        firmasAsignadas: {
          totalAsignadas: totalExistentesReales,
          vigentes: vigentesReales,
          porVencer: porVencerReales,
          expiradas: expiradosReales,
          listado: listadoFirmasReales,
        },
        accionesFuncionarios: {
          totalAccionesFirmaPeriodo: totalEventosPeriodo,
          totalAccionesFirmaHistorico: Math.max(totalEventosHistorico, totalEventosPeriodo),
          conexionesExcluidasPeriodo: eventosConectado,
          desconexionesExcluidasPeriodo: eventosDesconectado,
          listadoPorFuncionario: listadoAccionesReales,
        },
        contratosResumen: {
          totalContratos: contratosListadoReales.length,
          contratosVigentes: contratosListadoReales.filter((c: any) => c.estadoContrato === 'VIGENTE').length,
          contratosPorCaducar: contratosListadoReales.filter((c: any) => c.estadoContrato === 'POR_CADUCAR').length,
          contratosCaducados: contratosListadoReales.filter((c: any) => c.estadoContrato === 'CADUCADO').length,
          totalTokensContratados: contratosListadoReales.length,
          listado: contratosListadoReales,
        },
        alertasVencimiento: (() => {
          const itemsAlerta: any[] = [];
          let menosDe15Dias = 0;
          let entre16Y30Dias = 0;
          let entre31Y60Dias = 0;
          let expiradosCount = 0;
          for (const d of trazabilidadReales) {
            if (!d.fechaExpiracion || !d.funcionarioAsignado) continue;
            const diasRest = Math.ceil(
              (new Date(d.fechaExpiracion).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
            );
            if (diasRest <= 60) {
              const tramo =
                diasRest <= 0
                  ? 'EXPIRADO'
                  : diasRest <= 15
                    ? '15_DIAS'
                    : diasRest <= 30
                      ? '30_DIAS'
                      : '60_DIAS';
              if (tramo === 'EXPIRADO') expiradosCount += 1;
              else if (tramo === '15_DIAS') menosDe15Dias += 1;
              else if (tramo === '30_DIAS') entre16Y30Dias += 1;
              else entre31Y60Dias += 1;
              itemsAlerta.push({
                id: d.id,
                numeroSerie: `CERT-${d.serialNumber}`,
                serialNumberToken: d.serialNumber,
                hardwareModelo: `${d.marca} ${d.modelo}`.trim(),
                diasRestantes: diasRest,
                tramoAlerta: tramo,
                severidad: diasRest <= 15 ? 'ALTA' : diasRest <= 30 ? 'MEDIA' : 'BAJA',
                fechaInicio: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
                fechaExpiracion: d.fechaExpiracion,
                tiempoExpiracionTexto:
                  diasRest <= 0
                    ? `Expirado hace ${Math.abs(diasRest)} días`
                    : `${diasRest} días restantes`,
                usuario: {
                  id: d.id,
                  nombre: d.funcionarioAsignado.nombre,
                  rut: d.funcionarioAsignado.rut,
                  email: d.funcionarioAsignado.email || d.funcionarioAsignado.rut,
                  unidad: d.funcionarioAsignado.unidad,
                  cargo: d.funcionarioAsignado.cargo || 'Profesional',
                },
              });
            }
          }
          return {
            menosDe15Dias,
            entre16Y30Dias,
            entre31Y60Dias,
            totalEnUmbral60Dias: menosDe15Dias + entre16Y30Dias + entre31Y60Dias,
            expirados: expiradosCount,
            tokensEnAlerta: itemsAlerta,
          };
        })(),
        telemetria: {
          totalEstaciones,
          estacionesConectadas,
          estacionesFirmando,
          estacionesDesconectadas,
          porcentajeDisponibilidad,
          totalEventosPeriodo,
          eventosConectado,
          eventosFirmando,
          eventosDesconectado,
          porcentajeEventosConectado,
          porcentajeEventosFirmando,
          porcentajeEventosDesconectado,
          tokensRegistrados: totalExistentesReales,
          tokensOperativos: activosReales,
          tokensExpirados: expiradosReales,
          porcentajeTokensOperativos: pct(activosReales, totalExistentesReales),
          rankingEstaciones,
          trazabilidadDispositivos: trazabilidadReales,
          tiempoUsoTotalMinutos: trazabilidadReales.reduce(
            (acc: number, d: any) => acc + (d.tiempoUsoMinutos || 0),
            0,
          ),
          promedioUsoDiarioGeneralMinutos:
            trazabilidadReales.length > 0
              ? Math.round(
                  trazabilidadReales.reduce(
                    (acc: number, d: any) => acc + (d.promedioUsoDiarioMinutos || 0),
                    0,
                  ) / trazabilidadReales.length,
                )
              : 0,
          porcentajeUsoMedioMensual:
            trazabilidadReales.length > 0
              ? Number(
                  (
                    trazabilidadReales.reduce(
                      (acc: number, d: any) => acc + (d.porcentajeUsoMensual || 0),
                      0,
                    ) / trazabilidadReales.length
                  ).toFixed(1),
                )
              : 0,
        },
        firmas: {
          totalSolicitudesPeriodo,
          firmadas,
          pendientes,
          rechazadas,
          tasaExitoFirmaPct,
          tasaPendientesPct,
          tasaRechazoPct,
          fePublicaOtorgada,
          fePublicaPendiente,
          porcentajeFePublica,
          porClasificacion,
          porUnidad,
        },
        administracion: {
          totalUsuarios,
          usuariosActivos,
          usuariosPendientesAprobacion,
          usuariosNuevosPeriodo,
          porcentajeUsuariosActivos,
          totalCertificados,
          certificadosVigentes,
          certificadosPorVencer,
          certificadosRevocadosVencidos,
          porcentajeVigenciaCertificados,
          custodiaTokenFisico,
          custodiaCloud,
          porcentajeTokenFisico,
          porcentajeCloud,
          actasPeriodo: actasPeriodo.length,
          actasPorTipo,
          totalEventosAuditoriaPeriodo,
          auditoriaPorAccion,
          auditoriaPorModulo,
        },
        serieTemporal,
      };
    } catch (error) {
      this.logger.error(
        `Error al calcular métricas de trazabilidad: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
