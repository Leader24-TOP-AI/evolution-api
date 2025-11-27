import { ICache } from '@api/abstract/abstract.cache';
import { Logger } from '@config/logger.config';
import { withRedisTimeout } from '@utils/async-timeout';
import { BufferJSON } from 'baileys';

export class CacheService {
  private readonly logger = new Logger('CacheService');

  constructor(private readonly cache: ICache) {
    if (cache) {
      this.logger.verbose(`cacheservice created using cache engine: ${cache.constructor?.name}`);
    } else {
      this.logger.verbose(`cacheservice disabled`);
    }
  }

  async get(key: string): Promise<any> {
    if (!this.cache) {
      return;
    }
    try {
      return await withRedisTimeout(this.cache.get(key), 'cache:get');
    } catch (error) {
      this.logger.error(`[cache:get] ${error.message}`);
      return null;
    }
  }

  public async hGet(key: string, field: string) {
    if (!this.cache) {
      return null;
    }
    try {
      const data = await withRedisTimeout(this.cache.hGet(key, field), 'cache:hGet');

      if (data) {
        return JSON.parse(data, BufferJSON.reviver);
      }

      return null;
    } catch (error) {
      this.logger.error(`[cache:hGet] ${error.message}`);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number) {
    if (!this.cache) {
      return;
    }
    try {
      // Note: ICache.set() is synchronous (returns void), no timeout needed
      this.cache.set(key, value, ttl);
    } catch (error) {
      this.logger.error(`[cache:set] ${error.message}`);
    }
  }

  public async hSet(key: string, field: string, value: any) {
    if (!this.cache) {
      return;
    }
    try {
      const json = JSON.stringify(value, BufferJSON.replacer);
      await withRedisTimeout(this.cache.hSet(key, field, json), 'cache:hSet');
    } catch (error) {
      this.logger.error(`[cache:hSet] ${error.message}`);
    }
  }

  async has(key: string) {
    if (!this.cache) {
      return;
    }
    try {
      return await withRedisTimeout(this.cache.has(key), 'cache:has');
    } catch (error) {
      this.logger.error(`[cache:has] ${error.message}`);
      return false;
    }
  }

  async delete(key: string) {
    if (!this.cache) {
      return;
    }
    try {
      return await withRedisTimeout(this.cache.delete(key), 'cache:delete');
    } catch (error) {
      this.logger.error(`[cache:delete] ${error.message}`);
      return false;
    }
  }

  async hDelete(key: string, field: string) {
    if (!this.cache) {
      return false;
    }
    try {
      await withRedisTimeout(this.cache.hDelete(key, field), 'cache:hDelete');
      return true;
    } catch (error) {
      this.logger.error(`[cache:hDelete] ${error.message}`);
      return false;
    }
  }

  async deleteAll(appendCriteria?: string) {
    if (!this.cache) {
      return;
    }
    try {
      return await withRedisTimeout(this.cache.deleteAll(appendCriteria), 'cache:deleteAll');
    } catch (error) {
      this.logger.error(`[cache:deleteAll] ${error.message}`);
      return false;
    }
  }

  async keys(appendCriteria?: string) {
    if (!this.cache) {
      return;
    }
    try {
      return await withRedisTimeout(this.cache.keys(appendCriteria), 'cache:keys');
    } catch (error) {
      this.logger.error(`[cache:keys] ${error.message}`);
      return [];
    }
  }
}
