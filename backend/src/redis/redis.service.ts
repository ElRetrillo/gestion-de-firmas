import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private readonly ttlSeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.ttlSeconds = this.configService.get<number>('REDIS_PRESENCE_TTL') || 3600;
  }

  onModuleInit() {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD', '');

    this.client = new Redis({
      host,
      port,
      password: password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });

    this.client.connect()
      .then(() => {
        this.logger.log(`Conexión con Redis establecida en ${host}:${port}`);
      })
      .catch((err) => {
        this.logger.warn(`Redis no disponible de inmediato (${err.message}). Funcionamiento en modo resiliente.`);
      });
  }

  async setPresence(codigoPC: string, status: string, customTtl?: number): Promise<void> {
    if (!this.client) return;
    try {
      const key = `pc:status:${codigoPC}`;
      const ttl = customTtl || this.ttlSeconds;
      await this.client.set(key, status, 'EX', ttl);
    } catch (error) {
      this.logger.warn(`Error al actualizar presencia en Redis para ${codigoPC}: ${(error as Error).message}`);
    }
  }

  async getPresence(codigoPC: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(`pc:status:${codigoPC}`);
    } catch {
      return null;
    }
  }

  async getAllPresences(): Promise<Record<string, string>> {
    if (!this.client) return {};
    try {
      const keys = await this.client.keys('pc:status:*');
      if (keys.length === 0) return {};
      const values = await this.client.mget(keys);
      const result: Record<string, string> = {};
      keys.forEach((key, idx) => {
        const pc = key.replace('pc:status:', '');
        result[pc] = values[idx] || 'DESCONECTADO';
      });
      return result;
    } catch {
      return {};
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
      this.logger.log('Conexión con Redis cerrada.');
    }
  }
}
