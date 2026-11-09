import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/',
})
export class TelemetriaGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TelemetriaGateway.name);
  private syncTimer?: NodeJS.Timeout;

  afterInit(server: Server) {
    this.logger.log(
      'TelemetriaGateway inicializado. Activando ciclo de sincronización automática cada 10 segundos.',
    );
    this.iniciarCicloSincronizacion(10000);
  }

  onModuleDestroy() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  iniciarCicloSincronizacion(intervaloMs = 10000) {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    this.syncTimer = setInterval(() => {
      this.emitirSincronizacionAutomatica('ciclo_periodico_10s');
    }, intervaloMs);
  }

  emitirSincronizacionAutomatica(origen = 'ciclo_periodico') {
    if (this.server) {
      const payload = {
        timestamp: new Date().toISOString(),
        origen,
        intervaloSegundos: 10,
      };
      this.server.emit('sincronizacion_automatica', payload);
      this.server.to('dashboard-supervisores').emit('sincronizacion_automatica', payload);
    }
  }

  handleConnection(client: Socket) {
    this.logger.log(`Cliente WebSocket conectado: ${client.id}`);
    client.emit('sincronizacion_automatica', {
      timestamp: new Date().toISOString(),
      origen: 'on_connect',
      intervaloSegundos: 10,
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente WebSocket desconectado: ${client.id}`);
  }

  @SubscribeMessage('unirse_dashboard')
  handleJoinDashboard(client: Socket) {
    client.join('dashboard-supervisores');
    this.logger.log(`Cliente ${client.id} se unió a la sala dashboard-supervisores`);
    client.emit('sincronizacion_automatica', {
      timestamp: new Date().toISOString(),
      origen: 'unirse_dashboard',
      intervaloSegundos: 10,
    });
    return { status: 'ok', room: 'dashboard-supervisores' };
  }

  @SubscribeMessage('unirse_unidad')
  handleJoinUnidad(client: Socket, payload: { unidadId: string }) {
    if (payload?.unidadId) {
      const room = `unidad-${payload.unidadId}`;
      client.join(room);
      this.logger.log(`Cliente ${client.id} se unió a la sala ${room}`);
      return { status: 'ok', room };
    }
    return { status: 'error', message: 'unidadId requerido' };
  }

  broadcastEstadoPc(payload: {
    codigoPc: string;
    estadoHardware: 'DESCONECTADO' | 'CONECTADO';
    timestamp: string;
    ipAsignada?: string;
    dependenciaFisica?: string;
    serialNumber?: string;
    vendorId?: string;
    marca?: string;
    modelo?: string;
    tokenInfo?: {
      serialNumber?: string;
      vendorId?: string;
      marca?: string;
      modelo?: string;
    } | null;
    metadatos?: Record<string, unknown>;
  }) {
    if (this.server) {
      this.server.emit('estado_pc_actualizado', payload);
      this.server.emit('usb-status-changed', payload);
      this.server.to('dashboard-supervisores').emit('estado_pc_actualizado', payload);
      this.server.to('dashboard-supervisores').emit('usb-status-changed', payload);
      this.emitirSincronizacionAutomatica(`evento_usb_${payload.codigoPc}`);
    }
  }

  broadcastLimpiarMalla() {
    if (this.server) {
      this.server.emit('telemetria_malla_limpiada', { timestamp: new Date().toISOString() });
      this.emitirSincronizacionAutomatica('malla_limpiada');
    }
  }

  emitirActualizacionPresencia(payload: Record<string, unknown>) {
    if (this.server) {
      this.server.emit('evento_sistema_firma', payload);
      this.emitirSincronizacionAutomatica('actualizacion_presencia');
    }
  }

  emitirAccionFirma(payload: {
    codigoPc?: string;
    serialNumber?: string;
    funcionario?: { id: string; rut: string; nombre: string; unidad: string } | null;
    timestamp: string;
  }) {
    if (this.server) {
      this.server.emit('accion_firma_registrada', payload);
      this.server.to('dashboard-supervisores').emit('accion_firma_registrada', payload);
      this.emitirSincronizacionAutomatica('accion_firma');
    }
  }
}

