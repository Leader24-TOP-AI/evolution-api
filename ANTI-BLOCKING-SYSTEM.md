# Sistema Anti-Blocco Evolution API - Documentazione Completa

**Ultimo aggiornamento**: 27 Novembre 2025
**Versione**: 2.3.6
**Copertura stimata**: ~95%

---

## Indice

1. [Panoramica del Problema](#panoramica-del-problema)
2. [Architettura del Sistema](#architettura-del-sistema)
3. [Sistema Vecchio (Flag Management)](#sistema-vecchio-flag-management)
4. [Defense in Depth (Nuovo Sistema)](#defense-in-depth-nuovo-sistema)
5. [Fix Interazione Tra Sistemi](#fix-interazione-tra-sistemi)
6. [File Principali](#file-principali)
7. [Configurazione e Parametri](#configurazione-e-parametri)
8. [Monitoraggio e Debug](#monitoraggio-e-debug)
9. [Known Issues e Limitazioni](#known-issues-e-limitazioni)

---

## Panoramica del Problema

### Il Problema Originale
Le istanze WhatsApp (Baileys) possono bloccarsi in diversi scenari:
- **Proxy IP change**: Il proxy cambia IP e la connessione si blocca in stato "connecting"
- **Network instability**: Disconnessioni improvvise che lasciano il client in stato inconsistente
- **WhatsApp server issues**: Timeout o errori dal server WhatsApp
- **Memory leak**: Timer e listener non puliti che causano accumulo di risorse
- **Race conditions**: Operazioni concorrenti su restart che creano client duplicati

### Sintomi del Blocco
- Istanza rimane in stato `connecting` per minuti/ore
- Flag `isAutoRestarting` rimane `true` indefinitamente (deadlock)
- Heartbeat smette di aggiornarsi
- L'istanza non risponde ma il processo Node.js è vivo

---

## Architettura del Sistema

Il sistema anti-blocco è composto da **DUE sistemi** che lavorano insieme:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SISTEMA ANTI-BLOCCO COMPLETO                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────┐    ┌─────────────────────────────┐   │
│  │   SISTEMA VECCHIO       │    │   DEFENSE IN DEPTH          │   │
│  │   (Flag Management)     │    │   (3 Layer Protection)      │   │
│  │                         │    │                             │   │
│  │  - wasOpenBeforeReconnect    │  - Layer 1: Timeout         │   │
│  │  - isAutoRestarting     │    │  - Layer 2: Circuit Breaker │   │
│  │  - isRestartInProgress  │    │  - Layer 3: Watchdog        │   │
│  │  - autoRestart()        │    │                             │   │
│  │  - forceRestart()       │    │  + Resource Registry        │   │
│  │  - connectingTimer      │    │  + Graceful Shutdown        │   │
│  │  - safetyTimeout        │    │                             │   │
│  └─────────────────────────┘    └─────────────────────────────┘   │
│                                                                     │
│                    ↓ INTERAZIONE ↓                                  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │   FIX INTERAZIONE (6 fix critici implementati)              │   │
│  │   - Mutex atomico su isRestartInProgress                    │   │
│  │   - forceRestart() rispetta Circuit Breaker                 │   │
│  │   - Coordinamento watchdog ↔ autoRestart via DB             │   │
│  │   - Heartbeat riavviato dopo restart                        │   │
│  │   - Lock cleanupClient vs healthCheck                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Sistema Vecchio (Flag Management)

### File: `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

### Flag Principali

| Flag | Tipo | Scopo |
|------|------|-------|
| `wasOpenBeforeReconnect` | boolean | Indica se l'istanza era connessa prima della disconnessione |
| `isAutoRestarting` | boolean | Flag legacy per indicare restart in corso |
| `isRestartInProgress` | boolean | **Flag principale** per prevenire restart concorrenti |
| `isAutoRestartTriggered` | boolean | Indica se auto-restart è stato triggerato |
| `restartLockTimestamp` | number | Timestamp acquisizione lock (per timeout detection) |
| `isCleaningUp` | boolean | Indica cleanup in corso (blocca healthCheck) |

### Metodi Principali

#### `autoRestart()`
```typescript
private async autoRestart() {
  // 1. Acquisisce lock atomico
  if (!this.tryAcquireRestartLock('autoRestart')) return;

  // 2. Verifica Circuit Breaker
  if (!this.circuitBreaker.canExecute()) {
    this.releaseRestartLock('autoRestart-circuit_breaker_refused');
    return;
  }

  // 3. Verifica limiti globali
  // 4. Cleanup client esistente
  // 5. Attende stato 'close'
  // 6. Ricarica proxy
  // 7. Crea nuovo client
  // 8. Avvia heartbeat per monitoraggio watchdog
  // 9. Safety timeout per recovery se rimane bloccato
}
```

#### `forceRestart(reason: string)`
Simile a autoRestart ma chiamato esternamente (da healthCheck o watchdog).

#### `cleanupClient(reason: string)`
```typescript
private cleanupClient(reason: string): void {
  this.isCleaningUp = true; // Blocca healthCheck
  try {
    // 1. Chiude WebSocket
    // 2. Termina client Baileys
    // 3. Cancella timer (connectingTimer, safetyTimeout)
    // 4. Ferma healthCheck e heartbeat
  } finally {
    this.isCleaningUp = false;
  }
}
```

### Timer Critici

| Timer | Durata | Scopo |
|-------|--------|-------|
| `connectingTimer` | Dinamico (backoff) | Rileva istanza bloccata in 'connecting' |
| `safetyTimeout` | 30s | Recovery se istanza non raggiunge 'open' dopo restart |
| `healthCheckTimer` | 10s (interval) | Monitoraggio periodico stato istanza |
| `heartbeatTimer` | 30s (interval) | Aggiorna heartbeat DB per watchdog |

### Exponential Backoff

```typescript
private currentRestartDelay = 5000;     // Iniziale
private readonly MIN_RESTART_DELAY = 5000;   // Minimo 5s
private readonly MAX_RESTART_DELAY = 30000;  // Massimo 30s

private getNextRestartDelay(): number {
  const delay = this.currentRestartDelay;
  // Raddoppia fino al max
  this.currentRestartDelay = Math.min(
    this.currentRestartDelay * 2,
    this.MAX_RESTART_DELAY
  );
  return delay;
}
```

---

## Defense in Depth (Nuovo Sistema)

### Layer 1: Timeout Protection

**File**: `src/utils/async-timeout.ts`

Wrappa tutte le operazioni async con timeout configurabili:

```typescript
// Costanti timeout
export const TIMEOUT_DEFAULTS = {
  DATABASE: 5000,      // Query DB
  REDIS: 3000,         // Operazioni Redis
  HTTP: 15000,         // Chiamate HTTP
  WEBSOCKET: 2000,     // Eventi WebSocket
};

// Utilizzo
const result = await withDbTimeout(
  prisma.instance.findMany(),
  'fetchInstances'
);
```

#### Copertura Timeout

| Operazione | File | Copertura |
|------------|------|-----------|
| Query Prisma | whatsapp.baileys.service.ts | 98% |
| Redis (baileysCache) | whatsapp.baileys.service.ts | 100% |
| HTTP (axios) | whatsapp.baileys.service.ts | 100% |
| Watchdog DB | watchdog.service.ts | 100% |

### Layer 2: Circuit Breaker

**File**: `src/utils/circuit-breaker.ts`

State machine per prevenire cascade failures:

```
     ┌──────────────────────────────────────────────────────────┐
     │                                                          │
     ▼                                                          │
  CLOSED ──────────> OPEN ──────────> HALF_OPEN ───────────────┘
  (normale)      (5 failures)      (dopo 60s)     (2 successi)
                     │                  │
                     │                  │
                     ▼                  ▼
              Tutte le richieste   Test limitato
              falliscono subito    (1 richiesta)
```

**Configurazione**:
```typescript
{
  failureThreshold: 5,      // Fallimenti per aprire
  successThreshold: 2,      // Successi per chiudere
  timeout: 60000,           // Tempo in OPEN prima di HALF_OPEN
}
```

**Utilizzo**:
```typescript
// In autoRestart/forceRestart
if (!this.circuitBreaker.canExecute()) {
  this.logger.error('Circuit Breaker is OPEN, refusing restart');
  return;
}

// Dopo successo
this.circuitBreaker.recordSuccess();

// Dopo fallimento
this.circuitBreaker.recordFailure('reason');

// Trip manuale
this.circuitBreaker.tripCircuit('exceeded_hard_max_attempts');
```

### Layer 3: External Watchdog

**Files**:
- `src/watchdog/watchdog.service.ts`
- `src/watchdog/index.ts`

Processo PM2 **separato** che monitora le istanze dall'esterno.

#### Come Funziona

1. **Polling** ogni 30s legge heartbeat dal DB
2. **Detection**:
   - Heartbeat stale (> 90s) → processo frozen
   - Stuck in 'connecting' (> 120s) → connessione bloccata
3. **Recovery Escalation**:

| Tentativo | Azione | Descrizione |
|-----------|--------|-------------|
| 1-2 | API Restart | `POST /instance/restart/:name` |
| 3-5 | DB Flag | Setta flag per force restart |
| 6+ | PM2 Restart | `pm2 restart evolution-api` |

#### Tabella WatchdogHeartbeat

```sql
CREATE TABLE "WatchdogHeartbeat" (
  id               TEXT PRIMARY KEY,
  instanceId       TEXT UNIQUE,
  processId        INT,
  lastHeartbeat    TIMESTAMP,    -- Ultimo heartbeat
  state            VARCHAR(20),  -- open/connecting/close
  stuckSince       TIMESTAMP,    -- Quando è entrato in connecting
  recoveryAttempts INT DEFAULT 0,
  circuitState     VARCHAR(20),  -- CLOSED/OPEN/HALF_OPEN/RESTARTING
  lastRecovery     TIMESTAMP
);
```

**IMPORTANTE**: `circuitState = 'RESTARTING'` indica al watchdog che un restart interno è in corso e NON deve intervenire.

### Resource Registry

**File**: `src/utils/resource-registry.ts`

Tracking centralizzato di tutte le risorse per prevenire memory leak:

```typescript
class ResourceRegistry {
  private timers: Map<NodeJS.Timeout, string>;
  private listeners: Map<EventEmitter, Map<string, Function[]>>;
  private processes: Map<ChildProcess, string>;

  addTimer(timer: NodeJS.Timeout, name: string): void;
  addListener(emitter: EventEmitter, event: string, fn: Function): void;
  addProcess(process: ChildProcess, name: string): void;

  cleanupAll(reason: string): CleanupResult;
}
```

### Graceful Shutdown

**File**: `src/main.ts`

```typescript
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function gracefulShutdown(signal: string) {
  // 1. Stop accepting new requests
  server.close();

  // 2. Close WhatsApp instances (with timeout per instance)
  for (const instance of waInstances) {
    // Cleanup ResourceRegistry FIRST
    instance.resourceRegistry.cleanupAll('graceful_shutdown');
    // Then close client (with 5s timeout)
    await Promise.race([
      instance.client.end('shutdown'),
      timeout(5000)
    ]);
  }

  // 3. Disconnect DB (with 10s timeout)
  await Promise.race([
    prisma.$disconnect(),
    timeout(10000)
  ]);

  process.exit(0);
}
```

---

## Fix Interazione Tra Sistemi

### Problema
Il sistema vecchio e Defense in Depth operavano in modo non coordinato, causando:
- Race condition tra restart concorrenti
- Watchdog che interveniva durante restart interno
- healthCheck che operava durante cleanup
- Timer non ricreati dopo restart

### FIX 1: Mutex Atomico su isRestartInProgress

**Prima**: Check e set separati = race condition
```typescript
// PROBLEMA: Non atomico!
if (this.isRestartInProgress) return;
this.isRestartInProgress = true;
```

**Dopo**: Lock atomico con timeout detection
```typescript
private tryAcquireRestartLock(caller: string): boolean {
  const now = Date.now();

  // Se lock attivo e non scaduto, rifiuta
  if (this.isRestartInProgress &&
      (now - this.restartLockTimestamp) < this.RESTART_LOCK_TIMEOUT) {
    return false;
  }

  // Se lock scaduto (> 2 min), forza acquisizione
  if (this.isRestartInProgress &&
      (now - this.restartLockTimestamp) >= this.RESTART_LOCK_TIMEOUT) {
    this.circuitBreaker.recordFailure('stale_restart_lock_detected');
  }

  // Acquisisci atomicamente
  this.isRestartInProgress = true;
  this.restartLockTimestamp = now;
  return true;
}

private releaseRestartLock(caller: string): void {
  this.isRestartInProgress = false;
  this.restartLockTimestamp = 0;
}
```

### FIX 2: forceRestart() Rispetta Circuit Breaker

**Prima**: forceRestart() bypassava Circuit Breaker
```typescript
private async forceRestart(reason: string) {
  // Nessun check Circuit Breaker!
  if (this.isRestartInProgress) return;
  // ...
}
```

**Dopo**: Stesso check di autoRestart()
```typescript
private async forceRestart(reason: string) {
  if (!this.tryAcquireRestartLock('forceRestart')) return;

  // ✅ Ora rispetta Circuit Breaker
  if (!this.circuitBreaker.canExecute()) {
    this.releaseRestartLock('forceRestart-circuit_breaker_refused');
    return;
  }
  // ...
}
```

### FIX 3: Coordinamento Watchdog ↔ autoRestart

**Problema**: Watchdog e autoRestart potevano creare client duplicati.

**Soluzione**: Heartbeat segnala stato RESTARTING

```typescript
// In updateHeartbeat() - whatsapp.baileys.service.ts
private async updateHeartbeat() {
  const effectiveCircuitState = this.isRestartInProgress
    ? 'RESTARTING'  // ← Segnala al watchdog
    : this.circuitBreaker.getState();

  await this.prismaRepository.watchdogHeartbeat.upsert({
    where: { instanceId: this.instanceId },
    update: {
      circuitState: effectiveCircuitState,
      // ...
    }
  });
}

// In watchdog.service.ts - _performInstanceChecks()
if (heartbeat.circuitState === 'RESTARTING') {
  this.log('INFO', `Instance ${name} - Internal restart in progress, skipping`);
  continue;  // ← Non interviene
}
```

### FIX 4: Heartbeat Riavviato Dopo Restart

**Problema**: Dopo autoRestart/forceRestart, il watchdog non poteva monitorare l'istanza durante 'connecting' perché heartbeat era stato fermato.

**Soluzione**: Riavviare heartbeat subito dopo createClient()

```typescript
// In autoRestart() e forceRestart()
await this.createClient(this.phoneNumber);

// ✅ Avvia heartbeat SUBITO per permettere al watchdog di monitorare
this.startHeartbeat();
this.logger.info('Heartbeat restarted for watchdog monitoring during connecting phase');

this.releaseRestartLock('autoRestart-createClient_success');
```

### FIX 5: Deduplicazione safetyTimeout

**Già implementato**: Prima di creare un nuovo safetyTimeout, il precedente viene cancellato.

```typescript
if (this.safetyTimeout) {
  clearTimeout(this.safetyTimeout);
  this.safetyTimeout = null;
}
this.safetyTimeout = setTimeout(() => { ... }, 30000);
```

### FIX 6: Lock cleanupClient vs healthCheck

**Problema**: healthCheck poteva eseguire mentre cleanupClient stava distruggendo il client.

**Soluzione**: Flag `isCleaningUp`

```typescript
// In cleanupClient()
private cleanupClient(reason: string): void {
  this.isCleaningUp = true;  // ← Blocca healthCheck
  try {
    // cleanup...
  } finally {
    this.isCleaningUp = false;
  }
}

// In performHealthCheck()
private async performHealthCheck() {
  if (this.isCleaningUp) {
    this.logger.verbose('Skipping: cleanup in progress');
    return;  // ← Non esegue
  }
  // ...
}
```

---

## File Principali

### Backend Core

| File | Scopo | LOC |
|------|-------|-----|
| `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` | Servizio principale WhatsApp Baileys | ~6500 |
| `src/utils/async-timeout.ts` | Timeout utilities | ~100 |
| `src/utils/circuit-breaker.ts` | Circuit Breaker | ~200 |
| `src/utils/resource-registry.ts` | Resource tracking | ~150 |
| `src/watchdog/watchdog.service.ts` | Watchdog esterno | ~400 |
| `src/main.ts` | Entry point + graceful shutdown | ~250 |

### Database

| File | Scopo |
|------|-------|
| `prisma/postgresql-schema.prisma` | Schema Prisma (include WatchdogHeartbeat, HealthEvent) |

### Configurazione

| File | Scopo |
|------|-------|
| `ecosystem.config.js` | Configurazione PM2 (evolution-api + evolution-watchdog) |
| `.env` | Variabili ambiente |

---

## Configurazione e Parametri

### Timeout Defaults (async-timeout.ts)

```typescript
export const TIMEOUT_DEFAULTS = {
  DATABASE: 5000,      // 5s per query DB
  REDIS: 3000,         // 3s per operazioni Redis
  HTTP: 15000,         // 15s per chiamate HTTP
  WEBSOCKET: 2000,     // 2s per eventi WebSocket
};
```

### Circuit Breaker (circuit-breaker.ts)

```typescript
const DEFAULT_CONFIG = {
  failureThreshold: 5,       // Fallimenti per aprire
  successThreshold: 2,       // Successi per chiudere
  timeout: 60000,            // 60s in OPEN prima di HALF_OPEN
};
```

### Restart Limits (whatsapp.baileys.service.ts)

```typescript
private readonly maxAutoRestartAttempts = 10;      // Soft limit (logging)
private readonly HARD_MAX_RESTART_ATTEMPTS = 50;   // Hard limit → trip circuit
private readonly GLOBAL_RESTART_MAX = 20;          // Max restart in window
private readonly GLOBAL_RESTART_WINDOW = 300000;   // 5 min window
private readonly HARD_MAX_RECURSION_DEPTH = 5;     // Max safety timeout recursion
private readonly RESTART_LOCK_TIMEOUT = 120000;    // 2 min max per lock
```

### Watchdog (watchdog.service.ts)

```typescript
const DEFAULT_CONFIG = {
  checkInterval: 30000,      // Poll ogni 30s
  heartbeatTimeout: 90000,   // Heartbeat stale dopo 90s
  connectingTimeout: 120000, // Stuck connecting dopo 120s
  maxRecoveryAttempts: 5,    // Prima di PM2 restart
};
```

---

## Monitoraggio e Debug

### Comandi PM2

```bash
# Status processi
pm2 list

# Logs evolution-api
pm2 logs evolution-api

# Logs watchdog
pm2 logs evolution-watchdog

# Debug mode watchdog
WATCHDOG_DEBUG=true pm2 restart evolution-watchdog
```

### Health Monitor API

```bash
# Dashboard completo
curl http://localhost:8080/health-monitor/dashboard -H "apikey: YOUR_KEY"

# Status istanze
curl http://localhost:8080/health-monitor/instances -H "apikey: YOUR_KEY"

# Reset circuit breaker
curl -X POST http://localhost:8080/health-monitor/circuit-breaker/reset/INSTANCE_NAME \
  -H "apikey: YOUR_KEY"
```

### Log Pattern da Monitorare

```bash
# Auto-restart
grep -E "Auto-Restart|ForceRestart" /root/.pm2/logs/evolution-api-out.log

# Circuit Breaker
grep -E "Circuit Breaker|OPEN|HALF_OPEN" /root/.pm2/logs/evolution-api-out.log

# Watchdog recovery
grep -E "restart|recovery|stuck" /root/.pm2/logs/evolution-watchdog-out.log

# Lock/Mutex
grep -E "RestartLock|ACQUIRED|RELEASED" /root/.pm2/logs/evolution-api-out.log

# Health check
grep -E "HealthCheck|Skipping" /root/.pm2/logs/evolution-api-out.log
```

---

## Known Issues e Limitazioni

### Limitazioni Attuali

1. **Baileys operations senza timeout**: `sendMessage()`, `groupMetadata()`, `presenceSubscribe()` non hanno timeout wrapper. Potrebbero bloccarsi indefinitamente.

2. **FFmpeg timeout**: Le conversioni audio con FFmpeg non hanno timeout configurato.

3. **Single-thread Node.js**: Se un'operazione blocca il thread principale, tutto il processo si blocca. Il watchdog può rilevare ma non prevenire.

### Possibili Miglioramenti Futuri

1. **Timeout su Baileys operations**: Wrappare sendMessage, groupMetadata con Promise.race
2. **Worker threads**: Spostare operazioni pesanti su worker separati
3. **Redis pub/sub**: Coordinamento real-time invece di polling DB
4. **Metrics/Prometheus**: Export metriche per monitoring esterno

---

## Cronologia Implementazioni

| Data | Commit | Descrizione |
|------|--------|-------------|
| 2025-11-27 | 03d26251 | Prima implementazione Defense in Depth (~55%) |
| 2025-11-27 | 0f7e256b | Fix critici Layer 1-2-3 (~85%) |
| 2025-11-27 | 4d7c80a2 | Fix interazione sistemi (~95%) |

---

## Per Altri Sviluppatori

Se stai lavorando su questo sistema:

1. **NON rimuovere il sistema vecchio**: Funziona insieme a Defense in Depth
2. **Usa sempre i metodi di lock**: `tryAcquireRestartLock()` e `releaseRestartLock()`
3. **Rispetta i timeout**: Usa `withDbTimeout`, `withRedisTimeout`, `withHttpTimeout`
4. **Registra risorse**: Usa `resourceRegistry.addTimer()` per tutti i timer
5. **Testa sotto stress**: Simula disconnessioni rapide e multiple

### Testing Consigliato

```bash
# Test riconnessione
npm run test:reconnect

# Verifica logs durante test
pm2 logs evolution-api --lines 100 | grep -E "Auto-Restart|Circuit|RestartLock"
```

---

*Documento generato da Claude Code - 27 Novembre 2025*
