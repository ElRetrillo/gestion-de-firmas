import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TelemetriaGateway } from '../websocket/telemetria.gateway';
import { TelemetriaUsbDto, EstadoHardwareEnum } from './dto/telemetria-usb.dto';
import { Prisma } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as crypto from 'crypto';
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

    // Solo se considera cambio de estado real (o acción efectiva de firma) si:
    // 1. Es una acción de firma (FIRMANDO)
    // 2. Hay un cambio efectivo en el estado físico (ej: DESCONECTADO -> CONECTADO o CONECTADO -> DESCONECTADO)
    // 3. O si estando conectado, cambia el número de serie del token físico insertado
    // 4. O si es el primer registro de la estación en la base de datos
    const stateChanged =
      dto.estadoHardware === EstadoHardwareEnum.FIRMANDO ||
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
   * Requisito 3: Registra una acción de firma electrónica proveniente de la sesión activa del funcionario
   * y del token conectado en el dispositivo. (1 acción = 1 firma realizada con el token).
   */
  async registrarAccionFirmaSesion(
    body: {
      rutFuncionario?: string;
      usuarioId?: string;
      serialNumber?: string;
      codigoPc?: string;
      glosaAccion?: string;
    },
    userContext?: { sub?: string; rut?: string; email?: string },
  ) {
    const ahora = new Date();
    let usuario: any = null;

    const targetId = body.usuarioId || userContext?.sub;
    const targetRut = body.rutFuncionario || userContext?.rut;

    if (targetId || targetRut) {
      usuario = await this.prisma.usuario
        .findFirst({
          where: {
            OR: [
              ...(targetId ? [{ id: targetId }] : []),
              ...(targetRut ? [{ rut: targetRut.trim() }] : []),
            ],
          },
          include: {
            certificados: {
              include: { tokenHardware: true },
            },
          },
        })
        .catch(() => null);
    }

    let token: any = null;
    if (body.serialNumber) {
      token = await this.prisma.tokenHardware
        .findUnique({
          where: { serialNumber: body.serialNumber.trim() },
          include: {
            certificados: { include: { usuario: true } },
          },
        })
        .catch(() => null);
    }

    if (!token && usuario?.certificados?.[0]?.tokenHardware) {
      token = usuario.certificados[0].tokenHardware;
    }

    if (!usuario && token?.certificados?.[0]?.usuario) {
      usuario = token.certificados[0].usuario;
    }

    if (!token) {
      token = await this.prisma.tokenHardware
        .findFirst({
          include: { certificados: { include: { usuario: true } } },
        })
        .catch(() => null);
      if (!usuario && token?.certificados?.[0]?.usuario) {
        usuario = token.certificados[0].usuario;
      }
    }

    const serialFinal = body.serialNumber || token?.serialNumber || 'SN-0529-CQM-TEST01';
    const codigoPcFinal =
      body.codigoPc ||
      `PC-${(usuario?.unidad || 'TICS').replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase()}-01`;

    const resultadoUsb = await this.registrarEventoUsb({
      codigoPc: codigoPcFinal,
      estadoHardware: EstadoHardwareEnum.FIRMANDO,
      serialNumber: serialFinal,
      vendorId: token?.vendorId || '0x0529',
      marca: token?.marca || 'Thales / SafeNet',
      modelo: token?.modelo || 'eToken 5110 CC (FIPS 140-2 L3)',
      dependenciaFisica: usuario?.unidad || 'Red Interna Municipal - Coquimbo',
      timestamp: ahora.toISOString(),
      metadatos: {
        accionFirma: true,
        stateChanged: true,
        isHeartbeat: false,
        origen: 'SESION_Y_TOKEN_DISPOSITIVO',
        usuarioId: usuario?.id || null,
        funcionarioRut: usuario?.rut || targetRut || null,
        funcionarioNombre: usuario?.nombre || 'Funcionario en Sesión',
        unidad: usuario?.unidad || 'Municipalidad de Coquimbo',
        glosaAccion:
          body.glosaAccion || 'Firma electrónica ejecutada desde sesión activa con token físico',
      },
    });

    if (usuario) {
      await this.prisma.historialCambio
        .create({
          data: {
            tablaAfectada: 'telemetria_eventos',
            registroId: serialFinal,
            accion: 'ACCION_FIRMA_TOKEN',
            usuarioId: usuario.id,
            usuarioEmail: usuario.email,
            diffJsonb: {
              serialNumberToken: serialFinal,
              codigoPc: codigoPcFinal,
              funcionarioRut: usuario.rut,
              funcionarioNombre: usuario.nombre,
              unidad: usuario.unidad,
              glosaAccion:
                body.glosaAccion || 'Firma electrónica con token realizada en sesión activa',
              timestamp: ahora.toISOString(),
            },
          },
        })
        .catch(() => {});
    }

    return {
      status: 'signature_action_recorded',
      mensaje: `Acción de firma registrada exitosamente para ${usuario?.nombre || 'funcionario'} con token ${serialFinal}.`,
      codigoPc: codigoPcFinal,
      serialNumber: serialFinal,
      funcionario: usuario
        ? {
            id: usuario.id,
            rut: usuario.rut,
            nombre: usuario.nombre,
            unidad: usuario.unidad,
          }
        : null,
      timestamp: ahora.toISOString(),
      telemetria: resultadoUsb,
    };
  }

  /**
   * Calcula métricas de trazabilidad, control de tokens, acciones de firma por funcionario,
   * vigencias (15, 30, 60 días), contratos y código LaTeX para períodos:
   * - ULTIMOS_7_DIAS
   * - ULTIMOS_15_DIAS
   * - ULTIMOS_30_DIAS
   * - POR_MES (YYYY-MM)
   * - POR_ANIO (YYYY)
   */
  async obtenerMetricasTrazabilidad(modoInput?: string, mesInput?: string, anioInput?: string) {
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
      'POR_MES',
      'POR_ANIO',
    ];
    const modo = modosValidos.includes(String(modoInput))
      ? (modoInput as 'ULTIMOS_7_DIAS' | 'ULTIMOS_15_DIAS' | 'ULTIMOS_30_DIAS' | 'POR_MES' | 'POR_ANIO')
      : 'ULTIMOS_30_DIAS';

    const ahora = new Date();
    const defaultMes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
    const mesSeleccionado =
      mesInput && /^\d{4}-\d{2}$/.test(mesInput) ? mesInput : defaultMes;

    const defaultAnio = String(ahora.getFullYear());
    const anioSeleccionado =
      anioInput && /^\d{4}$/.test(anioInput) ? anioInput : defaultAnio;

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
      const year = Number(anioSeleccionado);
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

    // Construir lista de años disponibles
    const aniosDisponibles = [0, 1, 2].map((offset) => {
      const y = String(ahora.getFullYear() - offset);
      return { valor: y, etiqueta: `Año ${y}` };
    });

    const pct = (parte: number, total: number) =>
      total > 0 ? Math.round((parte / total) * 1000) / 10 : 0;

    try {
      const [
        estacionesVivo,
        tokensHardware,
        eventosTelemetria,
        todosEventosFirma,
        solicitudesPeriodo,
        todasSolicitudesFirmadas,
        usuarios,
        certificados,
        actasPeriodo,
        historialPeriodo,
        contratosRaw,
      ] = await Promise.all([
        this.obtenerEstadosEstaciones(),
        this.prisma.tokenHardware.findMany({
          include: {
            certificados: {
              include: {
                usuario: {
                  select: { id: true, nombre: true, rut: true, unidad: true, cargo: true, email: true, estado: true },
                },
              },
            },
            actasCustodia: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: {
                usuario: {
                  select: { id: true, nombre: true, rut: true, unidad: true, cargo: true, email: true, estado: true },
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
        this.prisma.telemetriaEvento.findMany({
          where: { evento: 'FIRMANDO' },
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
        this.prisma.solicitudFirma.findMany({
          where: { estadoAprobacion: 'FIRMADA' },
          select: { id: true, usuarioSolicitanteId: true, updatedAt: true, tsaTimestamp: true },
        }),
        this.prisma.usuario.findMany({
          include: {
            certificados: {
              include: { tokenHardware: true },
            },
          },
        }),
        this.prisma.certificado.findMany({
          include: {
            usuario: true,
            tokenHardware: true,
          },
          orderBy: { validoHasta: 'asc' },
        }),
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
        this.prisma.contratoToken.findMany({
          orderBy: { fechaInicio: 'desc' },
        }).catch(() => []),
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

          const certAsignado = t.certificados?.[0];
          const actaReciente = t.actasCustodia?.[0];
          const usuarioTitular = certAsignado?.usuario || actaReciente?.usuario || null;

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
                  unidad: usuarioTitular.unidad,
                }
              : null,
            estacionActual: estacionViva?.codigoPc || eventosDelToken[0]?.codigoPc || null,
            estadoEnVivo: estacionViva?.estadoEnVivo || 'DESCONECTADO',
            totalEventosPeriodo: totalEventos,
            conexionesPeriodo: conexiones,
            firmasPeriodo: firmas,
            desconexionesPeriodo: desconexiones,
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

      // =========================================================================
      // DESGLOSE ESPECÍFICO DE CONTROL Y SEGUIMIENTO DE TOKENS (REQUISITOS 1 AL 7)
      // =========================================================================

      // Requisito 1 y 4: Firmas asignadas, titulares, estado y tiempo de expiración (15, 30, 60 días)
      const listadoFirmasAsignadas = certificados.map((c: any) => {
        const fExp = new Date(c.validoHasta);
        const fAsig = new Date(c.createdAt);
        const diasRestantes = Math.ceil((fExp.getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24));
        const serialToken = c.tokenHardware?.serialNumber || c.numeroSerie;

        let estadoToken: 'ACTIVO' | 'POR_VENCER_60' | 'POR_VENCER_30' | 'POR_VENCER_15' | 'EXPIRADO' = 'ACTIVO';
        let tiempoExpiracionTexto = '';

        if (diasRestantes < 0 || c.estado === 'VENCIDO' || c.estado === 'REVOCADO') {
          estadoToken = 'EXPIRADO';
          tiempoExpiracionTexto =
            diasRestantes < 0 ? `Expirado hace ${Math.abs(diasRestantes)} días` : 'Expirado / Revocado';
        } else if (diasRestantes <= 15) {
          estadoToken = 'POR_VENCER_15';
          tiempoExpiracionTexto = `${diasRestantes} días restantes (Crítico ≤15 días)`;
        } else if (diasRestantes <= 30) {
          estadoToken = 'POR_VENCER_30';
          tiempoExpiracionTexto = `${diasRestantes} días restantes (Alerta ≤30 días)`;
        } else if (diasRestantes <= 60) {
          estadoToken = 'POR_VENCER_60';
          tiempoExpiracionTexto = `${diasRestantes} días restantes (Preventivo ≤60 días)`;
        } else {
          estadoToken = 'ACTIVO';
          tiempoExpiracionTexto = `${diasRestantes} días restantes (Vigente)`;
        }

        // Acciones de firma (SOLO firmas realizadas, NUNCA conexiones ni desconexiones)
        const firmasTelemetriaPeriodo = eventosTelemetria.filter(
          (ev) =>
            ev.evento === 'FIRMANDO' &&
            (ev.tokenId === c.tokenHardwareId ||
              ev.token?.serialNumber === serialToken ||
              (ev.metadatosJsonb as any)?.usuarioId === c.usuarioId ||
              (ev.metadatosJsonb as any)?.funcionarioRut === c.usuario?.rut),
        ).length;

        const firmasDocPeriodo = solicitudesPeriodo.filter(
          (s) => s.estadoAprobacion === 'FIRMADA' && s.usuarioSolicitanteId === c.usuarioId,
        ).length;

        const firmasTelemetriaHist = todosEventosFirma.filter(
          (ev) =>
            ev.tokenId === c.tokenHardwareId ||
            ev.token?.serialNumber === serialToken ||
            (ev.metadatosJsonb as any)?.usuarioId === c.usuarioId ||
            (ev.metadatosJsonb as any)?.funcionarioRut === c.usuario?.rut,
        ).length;

        const firmasDocHist = todasSolicitudesFirmadas.filter(
          (s) => s.usuarioSolicitanteId === c.usuarioId,
        ).length;

        const accionesFirmaPeriodo = firmasTelemetriaPeriodo + firmasDocPeriodo;
        const accionesFirmaTotal = Math.max(
          accionesFirmaPeriodo,
          firmasTelemetriaHist + firmasDocHist,
        );

        const estacionViva = (estacionesVivo as any[]).find(
          (est) =>
            est.tokenInfo?.serialNumber === serialToken ||
            est.serialTokenActivo === serialToken,
        );

        return {
          id: c.id,
          numeroSerieCertificado: c.numeroSerie,
          serialNumberToken: serialToken,
          marca: c.tokenHardware?.marca || 'Thales / SafeNet',
          modelo: c.tokenHardware?.modelo || 'eToken 5110 CC (FIPS 140-2 L3)',
          vendorId: c.tokenHardware?.vendorId || '0x0529',
          funcionario: {
            id: c.usuario?.id || c.usuarioId,
            rut: c.usuario?.rut || '-',
            nombre: c.usuario?.nombre || 'Funcionario Municipal',
            email: c.usuario?.email || 'firma@municoquimbo.cl',
            cargo: c.usuario?.cargo || 'Funcionario',
            unidad: c.usuario?.unidad || 'Municipalidad de Coquimbo',
          },
          fechaAsignacion: fAsig.toISOString().split('T')[0],
          fechaExpiracion: fExp.toISOString().split('T')[0],
          diasRestantes,
          tiempoExpiracionTexto,
          estado: estadoToken,
          accionesFirmaPeriodo,
          accionesFirmaTotal,
          estacionActual: estacionViva?.codigoPc || null,
          estadoConexion: (estacionViva?.estadoEnVivo || 'DESCONECTADO') as
            | 'CONECTADO'
            | 'FIRMANDO'
            | 'DESCONECTADO',
          codigoContrato: contratosRaw[0]?.codigoContrato || 'CON-2025-TOKENS-CQM-01',
        };
      });

      const firmasVigentesCount = listadoFirmasAsignadas.filter((f) => f.estado === 'ACTIVO').length;
      const firmasPorVencerCount = listadoFirmasAsignadas.filter(
        (f) =>
          f.estado === 'POR_VENCER_60' ||
          f.estado === 'POR_VENCER_30' ||
          f.estado === 'POR_VENCER_15',
      ).length;
      const firmasExpiradasCount = listadoFirmasAsignadas.filter((f) => f.estado === 'EXPIRADO').length;

      // Requisito 2: Cantidades de dispositivos existentes (existentes en total, activos y expirados)
      const totalDispositivosExistentes = Math.max(
        tokensHardware.length,
        listadoFirmasAsignadas.length,
      );
      let dispositivosExpirados = 0;
      let dispositivosActivos = 0;

      if (tokensHardware.length > 0) {
        for (const t of tokensHardware as any[]) {
          const cert = t.certificados?.[0];
          const expiroCert =
            cert &&
            (new Date(cert.validoHasta).getTime() < ahora.getTime() ||
              cert.estado === 'VENCIDO' ||
              cert.estado === 'REVOCADO');
          if (t.estadoPatrimonial === 'DADO_DE_BAJA' || expiroCert) {
            dispositivosExpirados += 1;
          } else {
            dispositivosActivos += 1;
          }
        }
      } else {
        dispositivosExpirados = firmasExpiradasCount;
        dispositivosActivos = Math.max(0, totalDispositivosExistentes - dispositivosExpirados);
      }

      const resumenDispositivos = {
        totalExistentes: totalDispositivosExistentes,
        activos: dispositivosActivos,
        expirados: dispositivosExpirados,
        porcentajeActivos: pct(dispositivosActivos, totalDispositivosExistentes),
        porcentajeExpirados: pct(dispositivosExpirados, totalDispositivosExistentes),
        conectadosEnSesion: estacionesConectadas,
        firmandoEnSesion: estacionesFirmando,
      };

      // Requisito 3: Cantidad de acciones que ha hecho cada funcionario con su token
      // (Una acción es ESTRICTAMENTE una firma, NO conexiones ni desconexiones del token)
      const totalAccionesFirmaPeriodoGlobal =
        eventosFirmando + solicitudesPeriodo.filter((s) => s.estadoAprobacion === 'FIRMADA').length;

      const listadoAccionesPorFuncionario = usuarios
        .filter((u: any) => u.certificados && u.certificados.length > 0)
        .map((u: any) => {
          const cert = u.certificados[0];
          const token = cert?.tokenHardware;
          const serialToken = token?.serialNumber || cert?.numeroSerie || 'SN-SIN-ASIGNAR';
          const diasRestantesToken = cert?.validoHasta
            ? Math.ceil((new Date(cert.validoHasta).getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24))
            : 0;

          const eventosDelFuncionarioPeriodo = eventosTelemetria.filter(
            (ev) =>
              ev.tokenId === token?.id ||
              ev.token?.serialNumber === serialToken ||
              (ev.metadatosJsonb as any)?.usuarioId === u.id ||
              (ev.metadatosJsonb as any)?.funcionarioRut === u.rut,
          );

          // Solo FIRMANDO + Solicitudes firmadas cuentan como acciones
          const firmasUsbPeriodo = eventosDelFuncionarioPeriodo.filter(
            (ev) => ev.evento === 'FIRMANDO',
          );
          const firmasSolicitudesPeriodo = solicitudesPeriodo.filter(
            (s) => s.estadoAprobacion === 'FIRMADA' && s.usuarioSolicitanteId === u.id,
          );
          const accionesFirmaPeriodo = firmasUsbPeriodo.length + firmasSolicitudesPeriodo.length;

          // Conexiones y desconexiones se reportan aparte como excluidas del conteo de acciones
          const conexionesIgnoradasPeriodo = eventosDelFuncionarioPeriodo.filter(
            (ev) => ev.evento === 'CONECTADO',
          ).length;
          const desconexionesIgnoradasPeriodo = eventosDelFuncionarioPeriodo.filter(
            (ev) => ev.evento === 'DESCONECTADO',
          ).length;

          const firmasUsbHist = todosEventosFirma.filter(
            (ev) =>
              ev.tokenId === token?.id ||
              ev.token?.serialNumber === serialToken ||
              (ev.metadatosJsonb as any)?.usuarioId === u.id ||
              (ev.metadatosJsonb as any)?.funcionarioRut === u.rut,
          );
          const firmasSolHist = todasSolicitudesFirmadas.filter(
            (s) => s.usuarioSolicitanteId === u.id,
          );
          const accionesFirmaHistorico = Math.max(
            accionesFirmaPeriodo,
            firmasUsbHist.length + firmasSolHist.length,
          );

          const ultimaEvFirma = firmasUsbHist[0];
          const ultimaSolFirma = firmasSolHist[0];
          const ultimaFecha =
            ultimaEvFirma?.timestamp?.toISOString() ||
            ultimaSolFirma?.tsaTimestamp?.toISOString() ||
            ultimaSolFirma?.updatedAt?.toISOString() ||
            null;

          return {
            usuarioId: u.id,
            rut: u.rut,
            nombre: u.nombre,
            email: u.email,
            cargo: u.cargo,
            unidad: u.unidad,
            serialNumberToken: serialToken,
            modeloToken: token ? `${token.marca} ${token.modelo}` : 'eToken 5110 CC',
            estadoToken:
              diasRestantesToken < 0
                ? 'EXPIRADO'
                : diasRestantesToken <= 60
                ? 'POR_VENCER'
                : 'ACTIVO',
            diasRestantesToken,
            accionesFirmaPeriodo,
            accionesFirmaHistorico,
            conexionesIgnoradasPeriodo,
            desconexionesIgnoradasPeriodo,
            porcentajeParticipacionFirmas: pct(
              accionesFirmaPeriodo,
              Math.max(1, totalAccionesFirmaPeriodoGlobal),
            ),
            ultimaAccionFirma: ultimaFecha,
            codigoPcUltimaSesion: ultimaEvFirma?.codigoPc || null,
          };
        })
        .sort((a, b) => b.accionesFirmaPeriodo - a.accionesFirmaPeriodo || b.accionesFirmaHistorico - a.accionesFirmaHistorico);

      const totalAccionesFirmaPeriodo = listadoAccionesPorFuncionario.reduce(
        (acc, item) => acc + item.accionesFirmaPeriodo,
        0,
      );
      const totalAccionesFirmaHistorico = listadoAccionesPorFuncionario.reduce(
        (acc, item) => acc + item.accionesFirmaHistorico,
        0,
      );

      // Requisito 4: Alertas de vencimiento a 15, 30 y 60 días
      const menosDe15Dias = listadoFirmasAsignadas.filter(
        (f) => f.diasRestantes >= 0 && f.diasRestantes <= 15,
      ).length;
      const entre16Y30Dias = listadoFirmasAsignadas.filter(
        (f) => f.diasRestantes > 15 && f.diasRestantes <= 30,
      ).length;
      const entre31Y60Dias = listadoFirmasAsignadas.filter(
        (f) => f.diasRestantes > 30 && f.diasRestantes <= 60,
      ).length;

      const tokensEnAlerta = listadoFirmasAsignadas
        .filter((f) => f.diasRestantes <= 60)
        .map((f) => ({
          id: f.id,
          numeroSerie: f.numeroSerieCertificado,
          serialNumberToken: f.serialNumberToken,
          hardwareModelo: `${f.marca} ${f.modelo}`,
          diasRestantes: f.diasRestantes,
          tramoAlerta: (f.diasRestantes < 0
            ? 'EXPIRADO'
            : f.diasRestantes <= 15
            ? '15_DIAS'
            : f.diasRestantes <= 30
            ? '30_DIAS'
            : '60_DIAS') as '15_DIAS' | '30_DIAS' | '60_DIAS' | 'EXPIRADO',
          severidad: (f.diasRestantes <= 15
            ? 'ALTA'
            : f.diasRestantes <= 30
            ? 'MEDIA'
            : 'BAJA') as 'ALTA' | 'MEDIA' | 'BAJA',
          fechaInicio: f.fechaAsignacion,
          fechaExpiracion: f.fechaExpiracion,
          tiempoExpiracionTexto: f.tiempoExpiracionTexto,
          usuario: f.funcionario,
          ultimoAvisoEnviado: null,
        }));

      // Requisito 7: Resumen de Contratos de Obtención de Tokens
      const listadoContratos = contratosRaw.map((c: any) => {
        const fIni = new Date(c.fechaInicio);
        const fCad = new Date(c.fechaCaducidad);
        const diasRest = Math.ceil((fCad.getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24));
        const duracionTotal = Math.max(
          1,
          Math.ceil((fCad.getTime() - fIni.getTime()) / (1000 * 60 * 60 * 24)),
        );
        const transcurrido = Math.min(
          100,
          Math.max(
            0,
            Math.round(((ahora.getTime() - fIni.getTime()) / (fCad.getTime() - fIni.getTime())) * 100),
          ),
        );
        const estadoVigencia: 'VIGENTE' | 'POR_CADUCAR' | 'CADUCADO' =
          diasRest < 0 ? 'CADUCADO' : diasRest <= 60 ? 'POR_CADUCAR' : 'VIGENTE';
        const tiempoCaducidadTexto =
          diasRest < 0
            ? `Caducado hace ${Math.abs(diasRest)} días`
            : diasRest <= 60
            ? `${diasRest} días restantes (Por caducar)`
            : `${diasRest} días restantes (~${Math.round((diasRest / 30.4) * 10) / 10} meses)`;

        return {
          id: c.id,
          codigoContrato: c.codigoContrato,
          titulo: c.titulo,
          proveedor: c.proveedor,
          fechaInicio: fIni.toISOString(),
          fechaCaducidad: fCad.toISOString(),
          fechaInicioFormateada: fIni.toISOString().split('T')[0],
          fechaCaducidadFormateada: fCad.toISOString().split('T')[0],
          diasRestantes: diasRest,
          duracionTotalDias: duracionTotal,
          porcentajeTranscurrido: transcurrido,
          tiempoCaducidadTexto,
          estadoVigencia,
          cantidadTokens: c.cantidadTokens,
          montoReferencial: c.montoReferencial || 'Convenio Marco',
          descripcion: c.descripcion || '',
          documentoUrl: `/api/v1/equipamiento/contratos/${c.id}/pdf`,
        };
      });

      const payloadRespuesta = {
        periodo: {
          modo,
          mesSeleccionado,
          anioSeleccionado,
          etiquetaPeriodo,
          fechaInicio: fechaInicio.toISOString(),
          fechaFin: fechaFin.toISOString(),
          mesesDisponibles: Array.from(mesesMap.entries()).map(([valor, etiqueta]) => ({
            valor,
            etiqueta,
          })),
          aniosDisponibles,
        },
        resumenDispositivos,
        firmasAsignadas: {
          totalAsignadas: listadoFirmasAsignadas.length,
          vigentes: firmasVigentesCount,
          porVencer: firmasPorVencerCount,
          expiradas: firmasExpiradasCount,
          listado: listadoFirmasAsignadas,
        },
        accionesFuncionarios: {
          totalAccionesFirmaPeriodo,
          totalAccionesFirmaHistorico,
          conexionesExcluidasPeriodo: eventosConectado,
          desconexionesExcluidasPeriodo: eventosDesconectado,
          listadoPorFuncionario: listadoAccionesPorFuncionario,
        },
        alertasVencimiento: {
          menosDe15Dias,
          entre16Y30Dias,
          entre31Y60Dias,
          totalEnUmbral60Dias: menosDe15Dias + entre16Y30Dias + entre31Y60Dias,
          expirados: firmasExpiradasCount,
          tokensEnAlerta,
        },
        contratosResumen: {
          totalContratos: listadoContratos.length,
          contratosVigentes: listadoContratos.filter((c) => c.estadoVigencia === 'VIGENTE').length,
          contratosPorCaducar: listadoContratos.filter((c) => c.estadoVigencia === 'POR_CADUCAR').length,
          contratosCaducados: listadoContratos.filter((c) => c.estadoVigencia === 'CADUCADO').length,
          totalTokensContratados: listadoContratos.reduce((s, c) => s + (c.cantidadTokens || 0), 0),
          listado: listadoContratos,
        },
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
          tokensRegistrados: totalDispositivosExistentes,
          tokensOperativos: dispositivosActivos,
          tokensExpirados: dispositivosExpirados,
          porcentajeTokensOperativos: pct(dispositivosActivos, totalDispositivosExistentes),
          rankingEstaciones,
          trazabilidadDispositivos,
        },
        firmas: {
          totalSolicitudesPeriodo,
          firmadas: Math.max(firmadas, totalAccionesFirmaPeriodo),
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
          certificadosVigentes: firmasVigentesCount,
          certificadosPorVencer: firmasPorVencerCount,
          certificadosRevocadosVencidos: firmasExpiradasCount,
          porcentajeVigenciaCertificados: pct(
            firmasVigentesCount + firmasPorVencerCount,
            Math.max(1, listadoFirmasAsignadas.length),
          ),
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

      const codigoLatex = this.generarCodigoLatexSummary(payloadRespuesta);

      return {
        ...payloadRespuesta,
        latexPreview: {
          codigoLatex,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error al calcular métricas de trazabilidad: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private escapeLatex(str: unknown): string {
    return String(str ?? '')
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/([&%$#_{}])/g, '\\$1')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
  }

  /**
   * Requisito 6: Genera código fuente LaTeX (.tex) completo con el Summary estadístico y desglose de métricas
   * según el período seleccionado (Últimos 7 días, Últimos 15 días, Últimos 30 días, Por Mes, Por Año).
   */
  generarCodigoLatexSummary(data: any): string {
    const p = data.periodo || {};
    const disp = data.resumenDispositivos || {};
    const asig = data.firmasAsignadas || {};
    const acc = data.accionesFuncionarios || {};
    const alert = data.alertasVencimiento || {};
    const cont = data.contratosResumen || {};

    const filasFirmas = (asig.listado || [])
      .map(
        (f: any) =>
          `    ${this.escapeLatex(f.funcionario?.nombre)} & \\texttt{${this.escapeLatex(f.funcionario?.rut)}} & \\texttt{${this.escapeLatex(f.serialNumberToken)}} & ${this.escapeLatex(f.fechaExpiracion)} & ${this.escapeLatex(f.tiempoExpiracionTexto)} & \\textbf{${this.escapeLatex(f.estado)}} \\\\`,
      )
      .join('\n');

    const filasAcciones = (acc.listadoPorFuncionario || [])
      .map(
        (a: any) =>
          `    ${this.escapeLatex(a.nombre)} & \\texttt{${this.escapeLatex(a.rut)}} & ${this.escapeLatex(a.unidad)} & \\texttt{${this.escapeLatex(a.serialNumberToken)}} & \\textbf{${a.accionesFirmaPeriodo}} & ${a.accionesFirmaHistorico} & ${a.porcentajeParticipacionFirmas}\\% \\\\`,
      )
      .join('\n');

    const filasAlertas = (alert.tokensEnAlerta || [])
      .map(
        (al: any) =>
          `    \\texttt{${this.escapeLatex(al.serialNumberToken)}} & ${this.escapeLatex(al.usuario?.nombre)} & \\texttt{${this.escapeLatex(al.usuario?.email)}} & ${this.escapeLatex(al.fechaExpiracion)} & \\textbf{${al.diasRestantes} d.} & ${this.escapeLatex(al.tramoAlerta)} \\\\`,
      )
      .join('\n');

    const filasContratos = (cont.listado || [])
      .map(
        (c: any) =>
          `    \\texttt{${this.escapeLatex(c.codigoContrato)}} & ${this.escapeLatex(c.proveedor)} & ${this.escapeLatex(c.fechaInicioFormateada)} & ${this.escapeLatex(c.fechaCaducidadFormateada)} & ${this.escapeLatex(c.tiempoCaducidadTexto)} & ${c.cantidadTokens} & \\textbf{${this.escapeLatex(c.estadoVigencia)}} \\\\`,
      )
      .join('\n');

    return [
      `% ============================================================================`,
      `% SUMMARY EJECUTIVO DE CONTROL Y SEGUIMIENTO DE TOKENS DE FIRMA ELECTRONICA`,
      `% Ilustre Municipalidad de Coquimbo - Depto. de Gestion de Sistemas y TICs`,
      `% Periodo Evaluado: ${p.etiquetaPeriodo || 'Ultimos 30 dias'} (${p.modo || 'ULTIMOS_30_DIAS'})`,
      `% ============================================================================`,
      `\\documentclass[11pt,a4paper]{article}`,
      `\\usepackage[utf8]{inputenc}`,
      `\\usepackage[T1]{fontenc}`,
      `\\usepackage[spanish]{babel}`,
      `\\usepackage[margin=2.0cm]{geometry}`,
      `\\usepackage{booktabs}`,
      `\\usepackage{longtable}`,
      `\\usepackage{xcolor}`,
      `\\usepackage{fancyhdr}`,
      `\\usepackage{hyperref}`,
      ``,
      `\\definecolor{muniNavy}{RGB}{5, 46, 92}`,
      `\\definecolor{muniGold}{RGB}{217, 155, 22}`,
      ``,
      `\\pagestyle{fancy}`,
      `\\fancyhf{}`,
      `\\fancyhead[L]{\\small\\textbf{I. Municipalidad de Coquimbo} -- Control de Tokens de Firma Electrónica}`,
      `\\fancyhead[R]{\\small Período: \\textbf{${this.escapeLatex(p.etiquetaPeriodo)}}}`,
      `\\fancyfoot[C]{\\small Página \\thepage\\ -- Documento Oficial de Trazabilidad (Ley N° 19.799 / Ley N° 21.663)}`,
      ``,
      `\\begin{document}`,
      ``,
      `\\begin{center}`,
      `  {\\LARGE \\textbf{\\textcolor{muniNavy}{SUMMARY ESTADÍSTICO DE CONTROL Y SEGUIMIENTO DE TOKENS DE FIRMA ELECTRÓNICA}}}\\\\[0.3cm]`,
      `  {\\large Ilustre Municipalidad de Coquimbo -- Departamento de Gestión de Sistemas y TICs}\\\\[0.2cm]`,
      `  {\\normalsize \\textbf{Período Seleccionado:} ${this.escapeLatex(p.etiquetaPeriodo)} \\quad|\\quad \\textbf{Modalidad:} \\texttt{${this.escapeLatex(p.modo)}}}\\\\`,
      `  {\\footnotesize Desde: \\texttt{${this.escapeLatex((p.fechaInicio || '').slice(0, 10))}} -- Hasta: \\texttt{${this.escapeLatex((p.fechaFin || '').slice(0, 10))}}}`,
      `\\end{center}`,
      `\\vspace{0.3cm}`,
      `\\hrule`,
      `\\vspace{0.4cm}`,
      ``,
      `\\section{Cantidades de Dispositivos Existentes (Total, Activos y Expirados)}`,
      `Resumen del inventario de dispositivos criptográficos USB (Tokens PKCS\\#11) registrados a nivel institucional:`,
      ``,
      `\\begin{table}[h!]`,
      `\\centering`,
      `\\begin{tabular}{lrrr}`,
      `\\toprule`,
      `\\textbf{Categoría de Dispositivos} & \\textbf{Cantidad} & \\textbf{Porcentaje} & \\textbf{Estado Operacional} \\\\`,
      `\\midrule`,
      `Dispositivos Existentes en Total & \\textbf{${disp.totalExistentes ?? 0}} & 100.0\\% & Padrón Total Municipal \\\\`,
      `Dispositivos Activos (Vigentes) & \\textbf{${disp.activos ?? 0}} & ${disp.porcentajeActivos ?? 0}\\% & Habilitados para Firma \\\\`,
      `Dispositivos Expirados / Vencidos & \\textbf{${disp.expirados ?? 0}} & ${disp.porcentajeExpirados ?? 0}\\% & Requieren Renovación / Baja \\\\`,
      `Dispositivos Conectados en Sesión Actual & ${disp.conectadosEnSesion ?? 0} & -- & Telemetría USB en Vivo \\\\`,
      `\\bottomrule`,
      `\\end{tabular}`,
      `\\end{table}`,
      ``,
      `\\section{Firmas Asignadas, Titulares y Estado de Expiración}`,
      `Total de firmas asignadas: \\textbf{${asig.totalAsignadas ?? 0}} (Vigentes >60d: \\textbf{${asig.vigentes ?? 0}}, Próximas a vencer $\\le$60d: \\textbf{${asig.porVencer ?? 0}}, Expiradas: \\textbf{${asig.expiradas ?? 0}}).`,
      ``,
      `\\begin{longtable}{llllll}`,
      `\\toprule`,
      `\\textbf{Funcionario Titular} & \\textbf{RUT} & \\textbf{Token S/N} & \\textbf{Expira} & \\textbf{Tiempo Restante} & \\textbf{Estado} \\\\`,
      `\\midrule`,
      `\\endhead`,
      filasFirmas || `    Sin firmas asignadas & -- & -- & -- & -- & -- \\\\`,
      `\\bottomrule`,
      `\\end{longtable}`,
      ``,
      `\\section{Acciones de Firma por Funcionario con su Token}`,
      `\\textit{Nota Metodológica: Se contabiliza exclusivamente como \\textbf{acción} cada firma electrónica ejecutada con el token desde la sesión activa (\\textbf{${acc.totalAccionesFirmaPeriodo ?? 0}} firmas en el período; \\textbf{${acc.totalAccionesFirmaHistorico ?? 0}} acumuladas). Se excluyen explícitamente las conexiones (${acc.conexionesExcluidasPeriodo ?? 0}) y desconexiones (${acc.desconexionesExcluidasPeriodo ?? 0}) físicas del dispositivo USB.}`,
      ``,
      `\\begin{longtable}{llllrrr}`,
      `\\toprule`,
      `\\textbf{Funcionario} & \\textbf{RUT} & \\textbf{Unidad} & \\textbf{Token S/N} & \\textbf{Firmas Período} & \\textbf{Total Histórico} & \\textbf{\\% Part.} \\\\`,
      `\\midrule`,
      `\\endhead`,
      filasAcciones || `    Sin acciones registradas & -- & -- & -- & 0 & 0 & 0\\% \\\\`,
      `\\bottomrule`,
      `\\end{longtable}`,
      ``,
      `\\section{Vencimiento de Tokens (Umbrales 15, 30 y 60 Días)}`,
      `Distribución de tokens próximos a vencer para despacho de aviso por correo electrónico:`,
      `\\begin{itemize}`,
      `  \\item \\textbf{Umbral Crítico ($\\le 15$ días):} ${alert.menosDe15Dias ?? 0} token(s).`,
      `  \\item \\textbf{Umbral Medio ($16 - 30$ días):} ${alert.entre16Y30Dias ?? 0} token(s).`,
      `  \\item \\textbf{Umbral Preventivo ($31 - 60$ días):} ${alert.entre31Y60Dias ?? 0} token(s).`,
      `  \\item \\textbf{Expirados ($< 0$ días):} ${alert.expirados ?? 0} token(s).`,
      `\\end{itemize}`,
      ``,
      `\\begin{longtable}{llllrr}`,
      `\\toprule`,
      `\\textbf{Token S/N} & \\textbf{Funcionario} & \\textbf{Correo Aviso} & \\textbf{Expiración} & \\textbf{Restante} & \\textbf{Tramo} \\\\`,
      `\\midrule`,
      `\\endhead`,
      filasAlertas || `    Sin alertas en umbral & -- & -- & -- & -- & -- \\\\`,
      `\\bottomrule`,
      `\\end{longtable}`,
      ``,
      `\\section{Contratos de Obtención de Tokens (Inicio y Caducidad)}`,
      `Total de contratos registrados: \\textbf{${cont.totalContratos ?? 0}} (${cont.totalTokensContratados ?? 0} tokens cubiertos).`,
      ``,
      `\\begin{longtable}{lllllll}`,
      `\\toprule`,
      `\\textbf{Código Contrato} & \\textbf{Proveedor} & \\textbf{Inicio} & \\textbf{Caducidad} & \\textbf{Tiempo Restante} & \\textbf{Cupo} & \\textbf{Estado} \\\\`,
      `\\midrule`,
      `\\endhead`,
      filasContratos || `    Sin contratos registrados & -- & -- & -- & -- & 0 & -- \\\\`,
      `\\bottomrule`,
      `\\end{longtable}`,
      ``,
      `\\end{document}`,
    ].join('\n');
  }

  async obtenerCodigoLatexSummary(modoInput?: string, mesInput?: string, anioInput?: string) {
    const metricas = await this.obtenerMetricasTrazabilidad(modoInput, mesInput, anioInput);
    const sufijo =
      metricas.periodo.modo === 'POR_MES'
        ? metricas.periodo.mesSeleccionado
        : metricas.periodo.modo === 'POR_ANIO'
        ? metricas.periodo.anioSeleccionado
        : metricas.periodo.modo.toLowerCase();

    return {
      codigoLatex: metricas.latexPreview.codigoLatex,
      filename: `Summary-Control-Tokens-${sufijo}.tex`,
      periodo: metricas.periodo,
    };
  }

  /**
   * Requisito 6: Genera el documento PDF descargable del Summary Estadístico de Control de Tokens
   * correspondiente al código LaTeX previsualizado, para los períodos:
   * Últimos 7 días, Últimos 15 días, Últimos 30 días, Por Mes y Por Año.
   */
  async generarPdfSummaryMetricas(
    modoInput?: string,
    mesInput?: string,
    anioInput?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const m = await this.obtenerMetricasTrazabilidad(modoInput, mesInput, anioInput);
    const p = m.periodo;
    const disp = m.resumenDispositivos;
    const asig = m.firmasAsignadas;
    const acc = m.accionesFuncionarios;
    const alert = m.alertasVencimiento;
    const cont = m.contratosResumen;

    const pdfDoc = await PDFDocument.create();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontMono = await pdfDoc.embedFont(StandardFonts.Courier);

    let page = pdfDoc.addPage([595.28, 841.89]); // A4
    let y = 780;

    const addHeader = (pg: any, pageNum: number) => {
      pg.drawRectangle({
        x: 0,
        y: 775,
        width: 595.28,
        height: 67,
        color: rgb(0.02, 0.18, 0.36),
      });
      pg.drawText('ILUSTRE MUNICIPALIDAD DE COQUIMBO - CONTROL Y SEGUIMIENTO DE TOKENS FEA', {
        x: 40,
        y: 816,
        size: 11,
        font: fontBold,
        color: rgb(1, 1, 1),
      });
      pg.drawText(
        `SUMMARY ESTADISTICO Y DESGLOSE DE METRICAS (LaTeX/PDF) • PERIODO: ${p.etiquetaPeriodo.toUpperCase()}`,
        {
          x: 40,
          y: 798,
          size: 8.5,
          font: fontRegular,
          color: rgb(0.95, 0.82, 0.35),
        },
      );
      pg.drawText(
        `Ventana: ${p.fechaInicio.slice(0, 10)} al ${p.fechaFin.slice(0, 10)} | Modalidad: ${p.modo} | Pag. ${pageNum}`,
        {
          x: 40,
          y: 783,
          size: 7.5,
          font: fontMono,
          color: rgb(0.85, 0.9, 0.96),
        },
      );
    };

    let pageNumber = 1;
    addHeader(page, pageNumber);
    y = 750;

    const ensureSpace = (needed: number) => {
      if (y - needed < 50) {
        pageNumber += 1;
        page = pdfDoc.addPage([595.28, 841.89]);
        addHeader(page, pageNumber);
        y = 750;
      }
    };

    const drawSectionTitle = (title: string) => {
      ensureSpace(35);
      page.drawRectangle({
        x: 40,
        y: y - 4,
        width: 515,
        height: 18,
        color: rgb(0.92, 0.95, 0.99),
      });
      page.drawText(title, {
        x: 45,
        y: y,
        size: 9.5,
        font: fontBold,
        color: rgb(0.02, 0.18, 0.36),
      });
      y -= 20;
    };

    const drawMonoLine = (text: string, color = rgb(0.15, 0.15, 0.15), size = 8) => {
      ensureSpace(14);
      page.drawText(text.slice(0, 104), {
        x: 45,
        y,
        size,
        font: fontMono,
        color,
      });
      y -= 12.5;
    };

    // SECCIÓN 1: CANTIDADES DE DISPOSITIVOS EXISTENTES (Req 2)
    drawSectionTitle('1. CANTIDADES DE DISPOSITIVOS EXISTENTES (TOTAL, ACTIVOS Y EXPIRADOS)');
    drawMonoLine(
      `Dispositivos Existentes en Total : ${disp.totalExistentes} unidades (100%)`,
      rgb(0.05, 0.05, 0.05),
      8.5,
    );
    drawMonoLine(
      `Dispositivos Activos (Vigentes)  : ${disp.activos} unidades (${disp.porcentajeActivos}%) | En sesion activa: ${disp.conectadosEnSesion}`,
      rgb(0, 0.42, 0.18),
      8.5,
    );
    drawMonoLine(
      `Dispositivos Expirados / Baja    : ${disp.expirados} unidades (${disp.porcentajeExpirados}%)`,
      rgb(0.7, 0.1, 0.1),
      8.5,
    );
    y -= 6;

    // SECCIÓN 2: FIRMAS ASIGNADAS, TITULARES Y ESTADO DE EXPIRACIÓN (Req 1)
    drawSectionTitle(
      `2. FIRMAS ASIGNADAS (${asig.totalAsignadas}), TITULARES Y TIEMPO DE EXPIRACION`,
    );
    drawMonoLine(
      'FUNCIONARIO TITULAR          | RUT          | TOKEN S/N          | EXPIRACION | ESTADO / RESTANTE',
      rgb(0.02, 0.18, 0.36),
      7.5,
    );
    drawMonoLine('-'.repeat(98), rgb(0.5, 0.5, 0.5), 7.5);
    for (const f of asig.listado) {
      const nom = (f.funcionario?.nombre || '').padEnd(28, ' ').slice(0, 28);
      const rut = (f.funcionario?.rut || '').padEnd(12, ' ').slice(0, 12);
      const sn = (f.serialNumberToken || '').padEnd(18, ' ').slice(0, 18);
      const exp = (f.fechaExpiracion || '').padEnd(10, ' ').slice(0, 10);
      const est = `${f.estado} (${f.diasRestantes}d)`;
      drawMonoLine(`${nom} | ${rut} | ${sn} | ${exp} | ${est}`, rgb(0.15, 0.15, 0.15), 7.5);
    }
    y -= 6;

    // SECCIÓN 3: ACCIONES DE FIRMA POR FUNCIONARIO CON SU TOKEN (Req 3)
    drawSectionTitle(
      '3. ACCIONES POR FUNCIONARIO CON SU TOKEN (1 ACCION = 1 FIRMA, EXCLUYE CONEXIONES)',
    );
    drawMonoLine(
      `Total Acciones (Firmas) Periodo: ${acc.totalAccionesFirmaPeriodo} | Total Historico: ${acc.totalAccionesFirmaHistorico} | Conexiones excluidas: ${acc.conexionesExcluidasPeriodo}`,
      rgb(0.05, 0.25, 0.15),
      8,
    );
    drawMonoLine(
      'FUNCIONARIO                  | UNIDAD             | TOKEN S/N          | FIRMAS PER. | TOTAL HIST. | % PART.',
      rgb(0.02, 0.18, 0.36),
      7.5,
    );
    drawMonoLine('-'.repeat(98), rgb(0.5, 0.5, 0.5), 7.5);
    for (const a of acc.listadoPorFuncionario) {
      const nom = (a.nombre || '').padEnd(28, ' ').slice(0, 28);
      const uni = (a.unidad || '').padEnd(18, ' ').slice(0, 18);
      const sn = (a.serialNumberToken || '').padEnd(18, ' ').slice(0, 18);
      const fp = String(a.accionesFirmaPeriodo).padStart(11, ' ');
      const fh = String(a.accionesFirmaHistorico).padStart(11, ' ');
      const pt = `${a.porcentajeParticipacionFirmas}%`.padStart(7, ' ');
      drawMonoLine(`${nom} | ${uni} | ${sn} | ${fp} | ${fh} | ${pt}`, rgb(0.15, 0.15, 0.15), 7.5);
    }
    y -= 6;

    // SECCIÓN 4: TOKENS PRÓXIMOS A VENCER (15, 30 Y 60 DÍAS) (Req 4)
    drawSectionTitle(
      `4. VIGENCIA Y VENCIMIENTOS DE TOKENS (<=15d: ${alert.menosDe15Dias} | <=30d: ${alert.entre16Y30Dias} | <=60d: ${alert.entre31Y60Dias} | Expirados: ${alert.expirados})`,
    );
    drawMonoLine(
      'TOKEN S/N          | FUNCIONARIO             | CORREO NOTIFICACION          | EXPIRA     | TRAMO ALERTA',
      rgb(0.02, 0.18, 0.36),
      7.5,
    );
    drawMonoLine('-'.repeat(98), rgb(0.5, 0.5, 0.5), 7.5);
    for (const al of alert.tokensEnAlerta) {
      const sn = (al.serialNumberToken || '').padEnd(18, ' ').slice(0, 18);
      const nom = (al.usuario?.nombre || '').padEnd(23, ' ').slice(0, 23);
      const em = (al.usuario?.email || '').padEnd(28, ' ').slice(0, 28);
      const ex = (al.fechaExpiracion || '').padEnd(10, ' ').slice(0, 10);
      const tr = `${al.tramoAlerta} (${al.diasRestantes}d)`;
      drawMonoLine(`${sn} | ${nom} | ${em} | ${ex} | ${tr}`, rgb(0.2, 0.1, 0.1), 7.5);
    }
    y -= 6;

    // SECCIÓN 5: CONTRATOS DE OBTENCIÓN DE TOKENS (Req 7)
    drawSectionTitle(
      `5. CONTRATOS DE OBTENCION DE TOKENS (${cont.totalContratos} CONTRATOS | ${cont.totalTokensContratados} TOKENS)`,
    );
    drawMonoLine(
      'CODIGO CONTRATO         | PROVEEDOR                | INICIO     | CADUCIDAD  | CUPO | ESTADO Y CADUCIDAD',
      rgb(0.02, 0.18, 0.36),
      7.5,
    );
    drawMonoLine('-'.repeat(98), rgb(0.5, 0.5, 0.5), 7.5);
    for (const c of cont.listado) {
      const cod = (c.codigoContrato || '').padEnd(23, ' ').slice(0, 23);
      const prov = (c.proveedor || '').padEnd(24, ' ').slice(0, 24);
      const ini = (c.fechaInicioFormateada || '').padEnd(10, ' ').slice(0, 10);
      const cad = (c.fechaCaducidadFormateada || '').padEnd(10, ' ').slice(0, 10);
      const cupo = String(c.cantidadTokens).padStart(4, ' ');
      const est = `${c.estadoVigencia} (${c.diasRestantes}d)`;
      drawMonoLine(`${cod} | ${prov} | ${ini} | ${cad} | ${cupo} | ${est}`, rgb(0.15, 0.15, 0.15), 7.5);
    }

    ensureSpace(45);
    y -= 10;
    const digest = crypto
      .createHash('sha256')
      .update(`${p.modo}:${p.etiquetaPeriodo}:${disp.totalExistentes}:${acc.totalAccionesFirmaPeriodo}`)
      .digest('hex');
    drawMonoLine(`Sello SHA-256 Summary: ${digest}`, rgb(0, 0.4, 0.2), 7.5);

    const pdfBytes = await pdfDoc.save();
    const sufijo =
      p.modo === 'POR_MES'
        ? p.mesSeleccionado
        : p.modo === 'POR_ANIO'
        ? p.anioSeleccionado
        : p.modo.toLowerCase();

    return {
      buffer: Buffer.from(pdfBytes),
      filename: `Summary-Control-Tokens-${sufijo}.pdf`,
    };
  }
}
