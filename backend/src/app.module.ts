import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WebsocketModule } from './websocket/websocket.module';
import { AuthModule } from './auth/auth.module';
import { TelemetriaModule } from './telemetria/telemetria.module';
import { FirmasModule } from './firmas/firmas.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { EquipamientoModule } from './equipamiento/equipamiento.module';
import { AuditoriaModule } from './auditoria/auditoria.module';
import { IntegracionesModule } from './integraciones/integraciones.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const password = config.get<string>('REDIS_PASSWORD');
        return {
          connection: {
            host: config.get<string>('REDIS_HOST', 'localhost'),
            port: config.get<number>('REDIS_PORT', 6379),
            password: password ? password : undefined,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    PrismaModule,
    RedisModule,
    WebsocketModule,
    AuthModule,
    TelemetriaModule,
    FirmasModule,
    UsuariosModule,
    EquipamientoModule,
    AuditoriaModule,
    IntegracionesModule,
  ],
})
export class AppModule {}
