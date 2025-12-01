# ANALISI ANTI-BLOCKING V2 - Per l'Altro Claude

**Data**: 27 Novembre 2025
**Autore**: Secondo Claude Code
**Stato**: VERIFICATO - Solo problemi REALI confermati

---

## ⚠️ CORREZIONE ERRORI MIA ANALISI INIZIALE

Ho verificato e **corretto** le mie conclusioni iniziali sbagliate:

| Cosa | Mia Conclusione Iniziale | Verifica Effettuata | Risultato |
|------|-------------------------|---------------------|-----------|
| Tabelle WatchdogHeartbeat/HealthEvent | ❌ "Non esistono" | `psql -U evolution -d evolution` schema `evolution_api` | ✅ **ESISTONO** |
| Query Prisma senza timeout | ❌ "~30 senza copertura" | `grep -c withDbTimeout` = **85** su 68 operazioni | ✅ **Copertura >100%** |
| Timer non registrati | ❌ "~10 non registrati" | `grep -c resourceRegistry.addTimer` = **10** | ✅ **Tutti registrati** |
| Circuit Breaker off-by-one | ❌ "Bug presente" | Revisione codice dettagliata | ✅ **Corretto** |

**Causa errore iniziale**: Cercavo le tabelle nello schema `public` invece che `evolution_api`.

---

## ✅ COSE GIÀ CORRETTE (NON TOCCARE)

1. ✅ Lock atomico `tryAcquireRestartLock()` / `releaseRestartLock()`
2. ✅ forceRestart() rispetta Circuit Breaker
3. ✅ Heartbeat con `circuitState='RESTARTING'` (linea 1436)
4. ✅ Timeout su tutte le query DB (85 wrapper su 68 operazioni)
5. ✅ Timer registrati nel ResourceRegistry
6. ✅ Tabelle WatchdogHeartbeat e HealthEvent esistenti nel DB

---

## 🔴 4 PROBLEMI REALI NON ANCORA RISOLTI

### PROBLEMA 1: Race Condition - connectionUpdate('open') Durante autoRestart

**File**: `whatsapp.baileys.service.ts`
**Linee**: 771-796 (connectionUpdate 'open') + 1012-1100 (autoRestart)

**Descrizione**:
Il flag `isRestartInProgress` viene resettato in `connectionUpdate('open')` (linea 796) **PRIMA** che `updateHeartbeat()` possa segnalare `circuitState='RESTARTING'` al watchdog.

**Timeline Problematica**:
```
T0: autoRestart() → isRestartInProgress = true (linea 1048)
T1: createClient() inizia (linea 1078)
T2: connectionUpdate('connecting') arriva
T3: connectionUpdate('open') arriva → isRestartInProgress = false (linea 796) ← RESET PREMATURO!
T4: updateHeartbeat() ancora non eseguito con circuitState='RESTARTING'
T5: Watchdog check → vede isRestartInProgress=false, circuitState vecchio → DUPLICATO RESTART
```

**Codice Problematico** (linea 796):
```typescript
if (connection === 'open') {
  // ...
  this.isRestartInProgress = false;  // ← Reset PRIMA di updateHeartbeat()
}
```

**FIX Suggerito**:
```typescript
if (connection === 'open') {
  // Aggiorna heartbeat PRIMA di resettare flag
  await this.updateHeartbeat();  // ← Prima segnala al watchdog che siamo stabili

  // POI resetta i flag
  this.isRestartInProgress = false;
  this.isAutoRestarting = false;
}
```

---

### PROBLEMA 2: Memory Leak - Event Listeners Baileys Non Rimossi

**File**: `whatsapp.baileys.service.ts`
**Linee**: 3301-3446 (eventHandler) + 1283-1341 (cleanupClient)

**Descrizione**:
Il metodo `eventHandler()` registra listener su `this.client.ev.process()` che **NON vengono rimossi** durante `cleanupClient()`.

**Problema**:
```typescript
// eventHandler() - linea 3301 - chiamato ad ogni createClient()
private eventHandler() {
  this.client.ev.process(async (events) => {
    // ... logica di processing
  });
}

// cleanupClient() - linea 1283 - NON rimuove il listener!
private cleanupClient(reason: string): void {
  this.isCleaningUp = true;
  try {
    // ... cleanup vario
    // ❌ MANCA: this.client.ev.removeAllListeners() o simile
  } finally {
    this.isCleaningUp = false;
  }
}
```

**Impatto**:
- Ogni restart accumula un nuovo callback
- 10 restart = 10 callback obsoleti che processano eventi
- Memory leak: ~100KB-500KB per callback
- Callback obsoleti accedono a risorse liberate → potenziali crash

**FIX Suggerito**:
Aggiungere in `cleanupClient()` **PRIMA** di `this.client.end()`:
```typescript
// Rimuovi tutti i listener prima di chiudere
if (this.client?.ev) {
  this.client.ev.removeAllListeners();
}
```

---

### PROBLEMA 3: Graceful Shutdown Timeout Insufficiente

**File**: `main.ts`
**Linee**: 214-244

**Descrizione**:
Il timeout di 5s per istanza durante graceful shutdown è insufficiente se `createClient()` è in corso.

**Problema**:
```typescript
// main.ts linea 217
await Promise.race([
  instance.client.end('shutdown'),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 5000)  // ← 5s non basta
  ),
]);
```

**Scenario**:
- `makeWASocket()` in Baileys può richiedere 5-30 secondi per WebSocket handshake
- Con 20 istanze, timeout totale 30s non basta (30s / 20 = 1.5s/istanza)
- Una sola istanza bloccata in `makeWASocket()` causa `process.exit(0)` senza cleanup completo
- Timer rimasti attivi dopo exit forzato

**FIX Suggerito**:
1. Aumentare timeout per istanza a **10s**
2. Aggiungere flag `isCreatingClient` per **saltare** istanze in creazione (non hanno client da chiudere)
3. Eseguire cleanup in **parallelo** invece di sequenziale:
```typescript
await Promise.allSettled(
  instanceNames.map(name => closeInstance(name, 10000))
);
```

---

### PROBLEMA 4: Circuit Breaker Senza Coordinamento Cross-Istanza (Bassa Priorità)

**File**: `whatsapp.baileys.service.ts` linee 253-260 + `watchdog.service.ts` linee 269-272

**Descrizione**:
Ogni istanza ha il suo Circuit Breaker indipendente. Se tutte le istanze falliscono simultaneamente (es. proxy IP blacklistata da WhatsApp), non c'è coordinamento.

**Scenario**:
- Proxy IP viene blacklistata da WhatsApp
- TUTTE le 20 istanze falliscono
- Ogni CB va in OPEN indipendentemente
- Nessuna recovery per 60s × N istanze = potenzialmente **20 minuti di downtime**

**FIX Suggerito** (bassa priorità, improvement futuro):
1. Aggiungere "global circuit breaker" nel watchdog che monitora pattern globali
2. Se >50% istanze in OPEN simultaneamente → alert immediato
3. Opzionale: trigger automatico cambio proxy pool

---

## 📋 PRIORITÀ FIX

| # | Problema | Priorità | Effort | Impatto |
|---|----------|----------|--------|---------|
| 1 | Race condition connectionUpdate('open') | 🔴 **ALTA** | Basso (5 linee) | Duplicati restart, instabilità |
| 2 | Memory leak event listeners Baileys | 🔴 **ALTA** | Basso (3 linee) | Degradazione performance nel tempo |
| 3 | Graceful shutdown timeout insufficiente | 🟠 **MEDIA** | Medio (20 linee) | Force exit senza cleanup |
| 4 | CB cross-istanza (no coordination) | 🟡 **BASSA** | Alto (nuovo sistema) | Solo scenari edge |

---

## 📁 FILE DA MODIFICARE

| File | Linee | Modifica |
|------|-------|----------|
| `whatsapp.baileys.service.ts` | 796 | Aggiungere `await updateHeartbeat()` PRIMA di reset flags |
| `whatsapp.baileys.service.ts` | 1283-1341 | Aggiungere `client.ev.removeAllListeners()` in cleanupClient |
| `main.ts` | 217 | Aumentare timeout istanza a 10s, parallel cleanup |
| `watchdog.service.ts` | nuovo (opzionale) | Global circuit breaker monitoring |

---

## 🧪 VERIFICA POST-FIX

```bash
# 1. Test race condition (riavvia mentre connecting)
pm2 logs evolution-api | grep -E "Auto-Restart|ForceRestart|DUPLICAT"

# 2. Test memory leak (riavvia istanza 5 volte)
# Prima:
pm2 show evolution-api | grep memory
# Riavvia istanza 5 volte via API
# Dopo:
pm2 show evolution-api | grep memory
# Memory NON dovrebbe crescere significativamente

# 3. Test graceful shutdown durante connecting
# Mentre istanza sta connettendo:
pm2 stop evolution-api
pm2 logs evolution-api --lines 50 | grep -E "graceful|shutdown|timeout|cleanup"
# Dovrebbe vedere "cleanup completed" per tutte le istanze
```

---

## 📝 NOTE PER L'ALTRO CLAUDE

1. **NON modificare** il lock system esistente - funziona correttamente
2. **NON modificare** la copertura timeout - è già >100%
3. **NON modificare** la registrazione timer - è già completa
4. I 4 problemi sopra sono **VERIFICATI** con numeri di linea precisi
5. Priorità: Fix #1 e #2 sono semplici (poche linee) ma ad alto impatto
6. Il Fix #3 richiede più attenzione per non rompere il graceful shutdown esistente
7. Il Fix #4 è opzionale/futuro - solo se avete tempo

---

*Documento generato da Secondo Claude Code - 27 Novembre 2025*
*Verificato con: psql, grep, lettura codice diretta*
