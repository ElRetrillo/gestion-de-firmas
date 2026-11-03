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

    this.client.connect()
      .then(() => {
        this.logger.log(`Conexión con Redis establecida en ${host}:${port} (TTL Presencia: ${this.ttlSeconds}s)`);
      })
      .catch((err) => {
        this.logger.warn(`Redis no disponible de inmediato (${err.message}). Funcionamiento en modo resiliente.`);
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
      } catch {
        // Fallback a memoria
      }
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
    } catch {
      // Ignorar fallback
    }
  }

  async getKey(key: string): Promise<string | null> {
    if (this.client) {
      try {
        const val = await this.client.get(key);
        if (val) return val;
      } catch {
        // Fallback a memoria
      }
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
    } catch {
      // Ignorar
    }
  }

  async getAllPresences(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    // Primero cargar de memoria con TTL válido
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
    } catch {
      // Ignorar error de limpieza en Redis
    }
  }

  /**
   * Bloqueo distribuido (Redlock pattern) para evitar colisiones en firmas simultáneas (Sección 2.2)
   */
  async acquireLock(resourceKey: string, ttlMs = 15000): Promise<string | null> {
    const lockKey = `lock:${resourceKey}`;
    const token = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

    if (this.client) {
      try {
        const ok = await this.client.set(lockKey, token, 'PX', ttlMs, 'NX');
        return ok === 'OK' ? token : null;
      } catch {
        // Fallback en memoria si Redis no responde
      }
    }

    const existing = this.memoryFallback.get(lockKey);
    if (existing && existing.expiresAt > Date.now()) {
      return null;
    }
    this.memoryFallback.set(lockKey, { value: token, expiresAt: Date.now() + ttlMs });
    return token;
  }

  async releaseLock(resourceKey: string, token: string): Promise<void> {
    const lockKey = `lock:${resourceKey}`;
    const mem = this.memoryFallback.get(lockKey);
    if (mem && mem.value === token) {
      this.memoryFallback.delete(lockKey);
    }

    if (!this.client) return;
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await this.client.eval(script, 1, lockKey, token);
    } catch {
      // Ignorar error de liberación
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
