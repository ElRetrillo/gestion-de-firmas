import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Conexión con PostgreSQL establecida exitosamente.');
    } catch (error) {
      this.logger.warn(`Modo diferido: No se pudo conectar a PostgreSQL de inmediato (${(error as Error).message}).`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Conexión con PostgreSQL cerrada.');
  }
}
