# Caching Patterns - Redis + LocalCache

## Descrizione
Sistema di caching a due livelli: Redis (primario, distribuito) e LocalCache (fallback, in-memory). CacheEngine factory pattern per astrazione, con serializzazione BufferJSON per dati Baileys.

## Quando Usare
- Implementare caching per nuova funzionalità
- Modificare logica cache esistente
- Debug cache miss/hit
- Ottimizzare performance con caching
- Gestire invalidazione cache

## Pattern Principali

### CacheEngine Factory
**File**: `src/cache/cacheengine.ts`

```typescript
// Factory che ritorna Redis o LocalCache
const cache = CacheEngineFactory.create({
  provider: process.env.CACHE_REDIS_ENABLED ? 'redis' : 'local',
  // ... config
});
```

| Provider | Caratteristiche |
|----------|-----------------|
| **Redis** | Distribuito, persistente, TTL nativo |
| **LocalCache** | In-memory, single-instance, veloce |

### CacheService Adapter
**File**: `src/cache/cache.service.ts`

Adapter unificato che wrappa Redis/LocalCache:

```typescript
class CacheService {
  async get<T>(key: string): Promise<T | null>;
  async set(key: string, value: any, ttl?: number): Promise<void>;
  async delete(key: string): Promise<void>;
  async hGet<T>(key: string, field: string): Promise<T | null>;
  async hSet(key: string, field: string, value: any): Promise<void>;
}
```

### Key Building Convention
```
PREFIX:module:subkey:identifier
```

| Esempio | Uso |
|---------|-----|
| `evolution:instance:mybot` | Dati istanza |
| `evolution:baileys:mybot:creds` | Credenziali Baileys |
| `evolution:chatwoot:mybot:inbox` | Config Chatwoot |
| `evolution:session:sessionId` | Sessione chatbot |

### Hash Operations
Per dati strutturati usa Hash (hGet/hSet):

```typescript
// Salvare campo specifico
await cache.hSet('evolution:instance:mybot', 'status', 'connected');
await cache.hSet('evolution:instance:mybot', 'lastSeen', Date.now());

// Recuperare campo
const status = await cache.hGet('evolution:instance:mybot', 'status');
```

### BufferJSON Serialization
**Per dati Baileys** che contengono Buffer:

```typescript
import { BufferJSON } from '@whiskeysockets/baileys';

// Serializzare
const serialized = JSON.stringify(data, BufferJSON.replacer);
await cache.set(key, serialized);

// Deserializzare
const raw = await cache.get(key);
const data = JSON.parse(raw, BufferJSON.reviver);
```

**Quando usare BufferJSON**:
- Credenziali Baileys (`creds`)
- Keys (`pre-key`, `sender-key`)
- App state sync data

### TTL Configuration
| Tipo Dato | TTL Suggerito |
|-----------|---------------|
| Session data | 24h (86400s) |
| Instance config | No expiry |
| Temporary data | 1h (3600s) |
| Rate limit counters | 1min (60s) |

```typescript
// Con TTL
await cache.set('temp:data', value, 3600);

// Senza TTL (permanente)
await cache.set('config:data', value);
```

### Cache per Modulo
| Modulo | Prefix | Contenuto |
|--------|--------|-----------|
| Instance | `evolution:instance:` | Config, status |
| Baileys | `evolution:baileys:` | Creds, keys, state |
| Chatwoot | `evolution:chatwoot:` | Inbox, contact mapping |
| Session | `evolution:session:` | Chatbot sessions |

### Pattern con Timeout
**SEMPRE** wrappare operazioni Redis:

```typescript
import { withRedisTimeout } from '@utils/async-timeout';

// Get con timeout
const data = await withRedisTimeout(
  cache.get(key),
  'cacheGet'
);

// Set con timeout
await withRedisTimeout(
  cache.set(key, value),
  'cacheSet'
);
```

## File Critici
- `src/cache/cacheengine.ts` - Factory pattern
- `src/cache/cache.service.ts` - CacheService adapter
- `src/cache/rediscache.ts` - Redis implementation
- `src/cache/localcache.ts` - LocalCache implementation

## Best Practices

### DO (Fare)
- SEMPRE usare `withRedisTimeout()` per operazioni cache
- SEMPRE usare BufferJSON per dati Baileys
- Usare Hash per dati strutturati correlati
- Seguire convenzione key naming
- Impostare TTL appropriato per dati temporanei
- Gestire cache miss gracefully

### DON'T (Non fare)
- MAI salvare dati sensibili senza encryption
- MAI usare chiavi senza prefix (collision risk)
- MAI ignorare errori Redis (usare fallback)
- MAI cache di dati che cambiano frequentemente senza invalidation
- MAI serializzare Buffer senza BufferJSON

### Cache Invalidation Pattern
```typescript
// Invalida singola chiave
await cache.delete('evolution:instance:mybot');

// Invalida pattern (solo Redis)
await cache.deletePattern('evolution:instance:mybot:*');

// Invalida su update
async updateInstance(name, data) {
  await prisma.instance.update({ ... });
  await cache.delete(`evolution:instance:${name}`);
}
```

### Fallback Pattern
```typescript
async getData(key: string) {
  // Try cache first
  let data = await cache.get(key);

  if (!data) {
    // Cache miss - fetch from DB
    data = await prisma.entity.findUnique({ ... });

    // Populate cache for next time
    if (data) {
      await cache.set(key, data, 3600);
    }
  }

  return data;
}
```
