import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private readonly ttlSeconds: number;
  private readonly memoryFallback: Map<string, { value: string; expiresAt: number }> = new Map();

  constructor(private readonly configService: ConfigService) {
    this.ttlSeconds = Number(this.configService.get<number>('REDIS_PRESENCE_TTL')) || 3600;
  }

  onModuleInit() {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = Number(this.configService.get<number>('REDIS_PORT', 6379));
    const password = this.configService.get<string>('REDIS_PASSWORD', '');

    this.client = new Redis({
      host,
      port,
      password: password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });

    this.client
      .connect()
      .then(() => {
        this.logger.log(`Conexión con Redis establecida en ${host}:${port} (TTL: ${this.ttlSeconds}s)`);
      })
      .catch((err) => {
        this.logger.warn(`Redis no disponible de inmediato (${err.message}). Operando con respaldo en memoria.`);
      });
  }

  async setPresence(codigoPC: string, status: string, customTtl?: number): Promise<void> {
    const ttl = customTtl || this.ttlSeconds;
    const key = `pc:status:${codigoPC}`;
    this.memoryFallback.set(key, { value: status, expiresAt: Date.now() + ttl * 1000 });

    if (!this.client) return;
    try {
      await this.client.set(key, status, 'EX', ttl);
    } catch (error) {
      this.logger.warn(`Error al actualizar presencia en Redis para ${codigoPC}: ${(error as Error).message}`);
    }
  }

  async getPresence(codigoPC: string): Promise<string | null> {
    const key = `pc:status:${codigoPC}`;
    if (this.client) {
      try {
        const val = await this.client.get(key);
        if (val) return val;
      } catch {}
    }
    const mem = this.memoryFallback.get(key);
    if (mem && mem.expiresAt > Date.now()) {
      return mem.value;
    }
    return null;
  }

  async setKey(key: string, value: string, ttlSeconds = 86400): Promise<void> {
    this.memoryFallback.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    if (!this.client) return;
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch {}
  }

  async getKey(key: string): Promise<string | null> {
    if (this.client) {
      try {
        const val = await this.client.get(key);
        if (val) return val;
      } catch {}
    }
    const mem = this.memoryFallback.get(key);
    if (mem && mem.expiresAt > Date.now()) {
      return mem.value;
    }
    return null;
  }

  async delKey(key: string): Promise<void> {
    this.memoryFallback.delete(key);
    if (!this.client) return;
    try {
      await this.client.del(key);
    } catch {}
  }

  async getAllPresences(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const now = Date.now();
    for (const [k, v] of this.memoryFallback.entries()) {
      if (k.startsWith('pc:status:') && v.expiresAt > now) {
        result[k.replace('pc:status:', '')] = v.value;
      }
    }

    if (!this.client) return result;
    try {
      const keys = await this.client.keys('pc:status:*');
      if (keys.length === 0) return result;
      const values = await this.client.mget(keys);
      keys.forEach((key, idx) => {
        const pc = key.replace('pc:status:', '');
        result[pc] = values[idx] || 'DESCONECTADO';
      });
      return result;
    } catch {
      return result;
    }
  }

  async clearAllPresences(): Promise<void> {
    for (const k of Array.from(this.memoryFallback.keys())) {
      if (k.startsWith('pc:status:')) {
        this.memoryFallback.delete(k);
      }
    }
    if (!this.client) return;
    try {
      const keys = await this.client.keys('pc:status:*');
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch {}
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
