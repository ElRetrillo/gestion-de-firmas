import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/',
})
export class TelemetriaGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TelemetriaGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Cliente WebSocket conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente WebSocket desconectado: ${client.id}`);
  }

  @SubscribeMessage('unirse_dashboard')
  handleJoinDashboard(client: Socket) {
    client.join('dashboard-supervisores');
    this.logger.log(`Cliente ${client.id} se unió a la sala dashboard-supervisores`);
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
    estadoHardware: 'DESCONECTADO' | 'CONECTADO' | 'FIRMANDO';
    timestamp: string;
    tokenInfo?: {
      serialNumber?: string;
      vendorId?: string;
      marca?: string;
      modelo?: string;
    };
    metadatos?: Record<string, unknown>;
  }) {
    if (this.server) {
      this.server.to('dashboard-supervisores').emit('estado_pc_actualizado', payload);
      this.server.emit('estado_pc_actualizado', payload); // Emisión global de respaldo
    }
  }
}
