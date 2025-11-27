# Defense in Depth - Sistema Protezione 3 Layer

## Descrizione
Sistema a 3 strati per prevenire freeze delle istanze WhatsApp: Timeout (Layer 1), Circuit Breaker (Layer 2), External Watchdog (Layer 3). Ogni layer è indipendente e può recuperare anche se gli altri falliscono.

## Quando Usare
- Aggiungere nuova operazione asincrona (query DB, chiamate esterne, operazioni Redis)
- Wrappare query database o operazioni cache
- Gestire connessioni esterne (HTTP, WebSocket)
- Debug di instance freeze o hang
- Modificare recovery logic o escalation pattern
- Registrare nuovi timer, interval o listener

## Pattern Principali

### Layer 1: Timeout Protection
**File**: `src/utils/async-timeout.ts`

Wrappa operazioni async con timeout configurabili. Se l'operazione non completa entro il timeout, viene rifiutata con TimeoutError.

**Timeout Defaults**:
| Operazione | Timeout | Costante |
|------------|---------|----------|
| Database Query | 5000ms | `TIMEOUT_DEFAULTS.DB_QUERY` |
| Redis | 3000ms | `TIMEOUT_DEFAULTS.REDIS` |
| WebSocket Close | 2000ms | `TIMEOUT_DEFAULTS.WEBSOCKET_CLOSE` |
| HTTP Request | 10000ms | `TIMEOUT_DEFAULTS.HTTP_REQUEST` |
| FFmpeg | 30000ms | `TIMEOUT_DEFAULTS.FFMPEG` |

**Pattern d'uso**:
```typescript
// Query database
await withDbTimeout(prisma.instance.findMany(), 'fetchInstances');

// Operazione Redis
await withRedisTimeout(cache.get(key), 'cacheGet');

// Operazione generica
await withTimeout(operation(), timeout, 'operationName');
```

### Layer 2: Circuit Breaker
**File**: `src/utils/circuit-breaker.ts`

Previene cascade failures isolando istanze problematiche.

**Stati**:
```
CLOSED → OPEN (dopo 5 failures) → HALF_OPEN (dopo 60s) → CLOSED (dopo 2 successi)
```

| Stato | Comportamento |
|-------|---------------|
| CLOSED | Operazioni normali, traccia failures |
| OPEN | Fail-fast immediato, nessuna esecuzione |
| HALF_OPEN | Test recovery con richieste limitate |

**Pattern d'uso**:
```typescript
const breaker = CircuitBreakerRegistry.getInstance().getBreaker(instanceName);

// Check prima di operazioni costose
if (!breaker.canExecute()) {
  return; // Fail-fast
}

try {
  await operation();
  breaker.recordSuccess();
} catch (e) {
  breaker.recordFailure(e.message);
}
```

### Layer 3: External Watchdog
**Files**: `src/watchdog/watchdog.service.ts`, `src/watchdog/index.ts`

Processo PM2 separato che monitora e recupera istanze bloccate.

**Detections**:
| Problema | Tempo Rilevamento | Trigger |
|----------|-------------------|---------|
| Heartbeat stale | 90 secondi | Nessun update heartbeat |
| Stuck connecting | 120 secondi | Stato 'connecting' troppo lungo |

**Recovery Escalation**:
1. **API Restart** (tentativi 1-2): Restart gentile via REST API
2. **DB Force Flag** (tentativi 3-5): Flag nel DB per forzare reconnect
3. **PM2 Restart** (tentativi 6+): Restart completo del processo

### Resource Registry
**File**: `src/utils/resource-registry.ts`

Tracciamento centralizzato di tutte le risorse per prevenire memory leak.

**Risorse tracciate**: timers, intervals, listeners, child processes

**Pattern d'uso**:
```typescript
// Registrare timer
const timer = setTimeout(() => {}, 5000);
registry.addTimer(timer, 'reconnectTimer');

// Cleanup emergenza
registry.cleanupAll('shutdown');
```

## File Critici
- `src/utils/async-timeout.ts` - Wrapper timeout per operazioni async
- `src/utils/circuit-breaker.ts` - State machine circuit breaker
- `src/utils/resource-registry.ts` - Registry risorse per cleanup
- `src/watchdog/watchdog.service.ts` - Logica watchdog
- `src/watchdog/index.ts` - Entry point processo watchdog
- `src/api/services/health-monitor.service.ts` - Monitoraggio salute istanze

## Best Practices

### DO (Fare)
- SEMPRE wrappare query DB con `withDbTimeout()`
- SEMPRE registrare timer/interval nel ResourceRegistry
- SEMPRE usare circuit breaker per operazioni esterne ripetute
- SEMPRE aggiornare heartbeat regolarmente per istanze attive
- Controllare `canExecute()` prima di operazioni costose
- Usare `recordSuccess()`/`recordFailure()` per aggiornare stato circuit breaker

### DON'T (Non fare)
- MAI usare `setTimeout`/`setInterval` senza registrazione nel ResourceRegistry
- MAI fare query DB senza timeout protection
- MAI ignorare lo stato del circuit breaker
- MAI fare operazioni bloccanti nel main thread
- MAI dimenticare di chiamare `recordSuccess()` dopo operazioni riuscite
