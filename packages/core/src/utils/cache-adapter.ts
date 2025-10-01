import { RedisClientType } from 'redis';
import { REDIS_PREFIX, Env } from './index.js';
import { createLogger } from './logger.js';
import { DB } from '../db/db.js';

const logger = createLogger('cache');

const REDIS_TIMEOUT = Env.REDIS_TIMEOUT;

// Interface that both memory and Redis cache will implement
export interface CacheBackend<K, V> {
  get(key: K, updateTTL?: boolean): Promise<V | undefined>;
  set(key: K, value: V, ttl: number): Promise<void>;
  update(key: K, value: V): Promise<void>;
  clear(): Promise<void>;
  getTTL(key: K): Promise<number>;
  waitUntilReady(): Promise<void>;
}

// Memory cache implementation
export class MemoryCacheBackend<K, V> implements CacheBackend<K, V> {
  private cache: Map<K, CacheItem<V>>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map<K, CacheItem<V>>();
    this.maxSize = maxSize;
  }

  async get(key: K, updateTTL: boolean = false): Promise<V | undefined> {
    const item = this.cache.get(key);
    if (item) {
      const now = Date.now();
      item.lastAccessed = now;
      if (now - item.createdAt > item.ttl) {
        this.cache.delete(key);
        return undefined;
      }
      if (updateTTL) {
        item.createdAt = now;
      }

      return structuredClone(item.value);
    }
    return undefined;
  }

  async set(key: K, value: V, ttl: number): Promise<void> {
    if (this.cache.size >= this.maxSize) {
      this.evict();
    }
    this.cache.set(
      key,
      new CacheItem<V>(
        structuredClone(value),
        Date.now(),
        Date.now(),
        ttl * 1000
      )
    );
  }

  async update(key: K, value: V): Promise<void> {
    const item = this.cache.get(key);
    if (item) {
      item.value = value;
    }
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  async getTTL(key: K): Promise<number> {
    const item = this.cache.get(key);
    if (item) {
      return Math.max(
        0,
        Math.floor((item.createdAt + item.ttl - Date.now()) / 1000)
      );
    }
    return 0;
  }

  private evict(): void {
    let oldestKey: K | undefined;
    let oldestTime = Infinity;

    for (const [key, item] of this.cache.entries()) {
      if (item.lastAccessed < oldestTime) {
        oldestTime = item.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }

  getSize(): number {
    return this.cache.size;
  }

  getMemoryUsageEstimate(): number {
    let totalSize = 0;
    for (const item of this.cache.values()) {
      try {
        totalSize += Buffer.byteLength(JSON.stringify(item), 'utf8');
      } catch (e) {
        // In case of circular references
      }
    }
    return totalSize;
  }

  async waitUntilReady(): Promise<void> {
    return Promise.resolve();
  }
}

// Redis cache implementation with timeout handling
export class RedisCacheBackend<K, V> implements CacheBackend<K, V> {
  private client: RedisClientType;
  private prefix: string;
  private maxSize: number;
  private timeout: number;

  constructor(
    redisClient: RedisClientType,
    prefix: string = REDIS_PREFIX,
    maxSize: number = Env.DEFAULT_MAX_CACHE_SIZE,
    timeout: number = REDIS_TIMEOUT
  ) {
    this.client = redisClient;
    this.prefix = prefix;
    this.maxSize = maxSize;
    this.timeout = timeout;
  }

  private getKey(key: K): string {
    return `${REDIS_PREFIX}${this.prefix}${String(key)}`;
  }

  /**
   * Execute Redis operation with timeout
   * @param operation Function that performs the Redis operation
   * @param fallback Value to return if operation times out or fails
   * @param errorMessage Message to log if operation fails
   */
  private async withTimeout<T>(
    operation: () => Promise<T>,
    fallback: T,
    errorMessage: string
  ): Promise<T> {
    // check if the client is connected
    if (!this.client.isOpen) {
      logger.error(`${errorMessage}: Redis client is not open`);
      return fallback;
    }

    try {
      // Create a promise that rejects after timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        const id = setTimeout(() => {
          clearTimeout(id);
          reject(
            new Error(`Redis operation timed out after ${this.timeout}ms`)
          );
        }, this.timeout);
      });

      // Race the operation against the timeout
      return await Promise.race([operation(), timeoutPromise]);
    } catch (err) {
      logger.error(`${errorMessage}: ${err}`);
      return fallback;
    }
  }

  async get(key: K, updateTTL: boolean = false): Promise<V | undefined> {
    const redisKey = this.getKey(key);

    return this.withTimeout(
      async () => {
        const data = await this.client.get(redisKey);
        if (!data) return undefined;

        if (updateTTL) {
          // Update TTL if requested
          const ttl = await this.client.ttl(redisKey);
          if (ttl > 0) {
            await this.client.expire(redisKey, ttl);
          }
        }

        return JSON.parse(data) as V;
      },
      undefined,
      `Error getting key ${String(key)} from Redis`
    );
  }

  async set(key: K, value: V, ttl: number): Promise<void> {
    if (ttl === 0) {
      return;
    }
    const redisKey = this.getKey(key);

    await this.withTimeout(
      async () => {
        await this.client.set(redisKey, JSON.stringify(value), {
          EX: ttl,
        });
        return true;
      },
      false,
      `Error setting key ${String(key)} in Redis`
    );
  }

  async update(key: K, value: V): Promise<void> {
    const redisKey = this.getKey(key);

    await this.withTimeout(
      async () => {
        // Get current TTL
        const ttl = await this.client.ttl(redisKey);
        if (ttl <= 0) return false; // Key doesn't exist or has no TTL

        // Update value but keep the same TTL
        await this.client.set(redisKey, JSON.stringify(value), {
          EX: ttl,
        });
        return true;
      },
      false,
      `Error updating key ${String(key)} in Redis`
    );
  }

  async clear(): Promise<void> {
    await this.withTimeout(
      async () => {
        // Delete all keys with this prefix
        const keys = await this.client.keys(`${this.prefix}*`);
        if (keys && keys.length > 0) {
          await this.client.del(keys);
        }
        return true;
      },
      false,
      `Error clearing Redis cache`
    );
  }

  async getTTL(key: K): Promise<number> {
    return this.withTimeout(
      async () => {
        const ttl = await this.client.ttl(this.getKey(key));
        return ttl > 0 ? ttl : 0;
      },
      0,
      `Error getting TTL for key ${String(key)} from Redis`
    );
  }

  async waitUntilReady(): Promise<void> {
    while (!this.client.isOpen) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// SQL cache implementation
export class SQLCacheBackend<K, V> implements CacheBackend<K, V> {
  private db: DB;
  private prefix: string;
  private maxSize: number;
  static maintenanceStarted: boolean = false;

  constructor(
    prefix: string = '',
    maxSize: number = Env.DEFAULT_MAX_CACHE_SIZE
  ) {
    this.db = DB.getInstance();
    this.prefix = prefix;
    this.maxSize = maxSize;
    this.startMaintenance();
  }

  private startMaintenance() {
    if (SQLCacheBackend.maintenanceStarted) return;
    logger.debug('Starting SQL cache maintenance');
    SQLCacheBackend.maintenanceStarted = true;
    setInterval(
      () => {
        this.db
          .execute('DELETE FROM cache WHERE expires_at < ?', [Date.now()])
          .then((result) => {
            logger.debug(
              `${result.changed || result.rowCount || 0} stale entries removed from SQL cache`
            );
          })
          .catch((err) => {
            logger.error(`Error during SQL cache maintenance: ${err}`);
          });
      },
      1 * 60 * 60 * 1000 // hourly
    );
  }

  private getKey(key: K): string {
    return `${this.prefix}${String(key)}`;
  }

  async get(key: K, updateTTL: boolean = false): Promise<V | undefined> {
    const sqlKey = this.getKey(key);
    const now = Date.now();

    try {
      // Get the value and check expiration
      const result = await this.db.query(
        'SELECT value, expires_at FROM cache WHERE key = ?',
        [sqlKey]
      );

      if (!result.length) {
        return undefined;
      }

      const row = result[0];
      if (now > row.expires_at) {
        // Remove expired entry
        await this.db.execute('DELETE FROM cache WHERE key = ?', [sqlKey]);
        return undefined;
      }

      if (updateTTL) {
        const ttl = Math.max(0, row.expires_at - now);
        const timestampFunc = this.db.isSQLite()
          ? 'CURRENT_TIMESTAMP'
          : 'NOW()';
        await this.db.execute(
          `UPDATE cache SET expires_at = ?, last_accessed = ${timestampFunc} WHERE key = ?`,
          [now + ttl, sqlKey]
        );
      } else {
        const timestampFunc = this.db.isSQLite()
          ? 'CURRENT_TIMESTAMP'
          : 'NOW()';
        await this.db.execute(
          `UPDATE cache SET last_accessed = ${timestampFunc} WHERE key = ?`,
          [sqlKey]
        );
      }

      return JSON.parse(row.value) as V;
    } catch (err) {
      logger.error(`Error getting key ${String(key)} from SQL cache: ${err}`);
      return undefined;
    }
  }

  async set(key: K, value: V, ttl: number): Promise<void> {
    if (ttl === 0) return;

    const sqlKey = this.getKey(key);
    const expiresAt = Date.now() + ttl * 1000;
    const jsonValue = JSON.stringify(value);

    try {
      // Check current cache size
      const countResult = await this.db.query(
        'SELECT COUNT(*) as count FROM cache'
      );
      const currentSize = countResult[0].count;

      if (currentSize >= this.maxSize) {
        // Remove oldest accessed entry
        if (this.db.isSQLite()) {
          await this.db.execute(
            'DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY last_accessed ASC LIMIT 1)'
          );
        } else {
          // PostgreSQL compatible version
          await this.db.execute(
            'DELETE FROM cache WHERE key = (SELECT key FROM cache ORDER BY last_accessed ASC LIMIT 1)'
          );
        }
      }

      // Upsert the new value
      if (this.db.isSQLite()) {
        await this.db.execute(
          'INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)',
          [sqlKey, jsonValue, expiresAt]
        );
      } else {
        const timestampFunc = this.db.isSQLite()
          ? 'CURRENT_TIMESTAMP'
          : 'NOW()';
        await this.db.execute(
          `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, last_accessed = ${timestampFunc}`,
          [sqlKey, jsonValue, expiresAt]
        );
      }
    } catch (err) {
      logger.error(`Error setting key ${String(key)} in SQL cache: ${err}`);
    }
  }

  async update(key: K, value: V): Promise<void> {
    const sqlKey = this.getKey(key);

    try {
      const result = await this.db.query(
        'SELECT expires_at FROM cache WHERE key = ?',
        [sqlKey]
      );

      if (!result.length) return;

      const row = result[0];
      if (Date.now() > row.expires_at) {
        await this.db.execute('DELETE FROM cache WHERE key = ?', [sqlKey]);
        return;
      }

      const timestampFunc = this.db.isSQLite() ? 'CURRENT_TIMESTAMP' : 'NOW()';
      await this.db.execute(
        `UPDATE cache SET value = ?, last_accessed = ${timestampFunc} WHERE key = ?`,
        [JSON.stringify(value), sqlKey]
      );
    } catch (err) {
      logger.error(`Error updating key ${String(key)} in SQL cache: ${err}`);
    }
  }

  async clear(): Promise<void> {
    try {
      if (this.prefix) {
        await this.db.execute('DELETE FROM cache WHERE key LIKE ?', [
          `${this.prefix}%`,
        ]);
      } else {
        await this.db.execute('DELETE FROM cache');
      }
    } catch (err) {
      logger.error(`Error clearing SQL cache: ${err}`);
    }
  }

  async getTTL(key: K): Promise<number> {
    const sqlKey = this.getKey(key);
    const now = Date.now();

    try {
      const result = await this.db.query(
        'SELECT expires_at FROM cache WHERE key = ?',
        [sqlKey]
      );

      if (!result.length) return 0;

      const ttl = Math.max(0, Math.floor((result[0].expires_at - now) / 1000));
      return ttl;
    } catch (err) {
      logger.error(
        `Error getting TTL for key ${String(key)} from SQL cache: ${err}`
      );
      return 0;
    }
  }

  async waitUntilReady(): Promise<void> {
    if (!this.db.isInitialised()) {
      throw new Error('Database is not initialized');
    }
    return Promise.resolve();
  }
}

class CacheItem<T> {
  constructor(
    public value: T,
    public lastAccessed: number,
    public createdAt: number,
    public ttl: number // Time-To-Live in milliseconds
  ) {}
}
