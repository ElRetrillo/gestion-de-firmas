import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TelemetriaGateway } from '../websocket/telemetria.gateway';
import { TelemetriaUsbDto, EstadoHardwareEnum } from './dto/telemetria-usb.dto';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

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
    } | null = null;

    if (!isDesconectado && dto.serialNumber) {
      try {
        const token = await this.prisma.tokenHardware.upsert({
          where: { serialNumber: dto.serialNumber },
          update: {
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Desconocido',
            modelo: dto.modelo || 'Dispositivo Token USB',
          },
          create: {
            serialNumber: dto.serialNumber,
            vendorId: dto.vendorId || 'UNKNOWN',
            marca: dto.marca || 'Desconocido',
            modelo: dto.modelo || 'Dispositivo Token USB',
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
          marca: dto.marca || 'Desconocido',
          modelo: dto.modelo || 'Dispositivo Token USB',
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

    return Promise.all(
      estaciones.map(async (estacion) => {
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

    // Buscar el archivo main.js del agente Ghost App (en local o dentro del contenedor)
    const posiblesRutas = [
      path.resolve(process.cwd(), 'ghost-app/main.js'),
      path.resolve(process.cwd(), '../ghost-app/main.js'),
      path.resolve(__dirname, '../../ghost-app/main.js'),
    ];

    let mainJsContent = '';
    for (const r of posiblesRutas) {
      if (fs.existsSync(r)) {
        try {
          mainJsContent = fs.readFileSync(r, 'utf8');
          break;
        } catch {}
      }
    }

    if (!mainJsContent) {
      mainJsContent = `console.log("Agente GhostApp Coquimbo");`;
    }
    const mainJsBase64 = Buffer.from(mainJsContent, 'utf8').toString('base64');

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
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllBytes('%INSTALL_DIR%\\main.js', [Convert]::FromBase64String('${mainJsBase64}'))"`,
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
}
