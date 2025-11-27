# WhatsApp Baileys - Integrazione WhatsApp Web

## Descrizione
Integrazione WhatsApp tramite libreria Baileys (WhatsApp Web client). Gestisce connessione, autenticazione QR, messaggi, media, e stati di connessione. File principale oltre 6400 linee - il componente più complesso del sistema.

## Quando Usare
- Modificare logica di connessione WhatsApp
- Gestire reconnection e stati di connessione
- Implementare nuovi tipi di messaggi
- Debug disconnessioni o problemi di stabilità
- Gestire media (download, upload, conversione)
- Modificare gestione sessione e persistenza

## Pattern Principali

### Connection State Machine
```
disconnected → connecting → open
      ↑              ↓         ↓
      └──────────────┴─────────┘
```

| Stato | Descrizione |
|-------|-------------|
| `close` | Disconnesso, nessuna sessione attiva |
| `connecting` | Tentativo di connessione in corso |
| `open` | Connesso e operativo |

### BaileysStartupService Structure
**File**: `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

Classe principale che estende `ChannelStartupService`. Responsabilità:
- Gestione ciclo di vita connessione
- Handling eventi Baileys (messages.upsert, connection.update, etc.)
- Persistenza sessione (Prisma, Redis, Files)
- Invio/ricezione messaggi
- Gestione media e file

### Event Handlers Chiave
| Evento Baileys | Handling |
|----------------|----------|
| `connection.update` | Aggiorna stato, gestisce QR, rileva disconnessioni |
| `messages.upsert` | Processa messaggi in arrivo, trigger chatbot |
| `messages.update` | Aggiorna stato messaggi (delivered, read) |
| `messaging-history.set` | Sync storico messaggi |
| `contacts.upsert` | Aggiorna contatti |
| `groups.upsert` | Aggiorna gruppi |

### Reconnection Pattern
```typescript
// Exponential backoff per reconnection
const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
```

**Configurazione**:
- Base delay: 1000ms
- Max delay: 30000ms
- Max attempts: configurabile

### Media Handling Flow
```
Ricezione: WhatsApp → Download → Decrypt → Store (S3/Local) → URL
Invio: File → Validate → Convert (FFmpeg) → Encrypt → Upload → WhatsApp
```

**Conversioni FFmpeg**:
| Input | Output | Uso |
|-------|--------|-----|
| Audio vari | OGG Opus | Voice messages |
| Video vari | MP4 | Video messages |
| Immagini | WebP | Stickers |

### Session Persistence
**Opzioni storage**:
| Provider | File | Uso |
|----------|------|-----|
| Prisma | Database | Produzione (raccomandato) |
| Redis | Cache distribuita | Alta disponibilità |
| Files | File system | Development |

**Dati persistiti**: creds, keys, app-state-sync, sender-keys

### Message Processor
**File**: `src/api/integrations/channel/whatsapp/baileysMessage.processor.ts`

Processa messaggi in arrivo, normalizza struttura, estrae metadata.

## File Critici
- `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` - Service principale (6400+ linee)
- `src/api/integrations/channel/whatsapp/baileysMessage.processor.ts` - Processore messaggi
- `src/api/integrations/channel/channel.controller.ts` - Factory per channel services
- `src/api/integrations/channel/channel.service.ts` - Base service astratto

## Best Practices

### DO (Fare)
- SEMPRE usare circuit breaker per operazioni WhatsApp ripetute
- SEMPRE registrare timer di reconnection nel ResourceRegistry
- SEMPRE gestire tutti gli stati di connessione (close, connecting, open)
- Usare exponential backoff per reconnection
- Emettere eventi per cambi di stato (`connection.update`)
- Aggiornare heartbeat watchdog durante operazioni lunghe
- Validare media prima di inviare (size, type, duration)

### DON'T (Non fare)
- MAI ignorare errori di connessione - sempre loggare e gestire
- MAI fare reconnect immediato senza backoff
- MAI bloccare il main thread con operazioni sync
- MAI salvare credenziali in chiaro nei log
- MAI ignorare rate limits di WhatsApp
- MAI inviare media senza validazione preventiva

### Troubleshooting Comune
| Sintomo | Causa Probabile | Soluzione |
|---------|-----------------|-----------|
| QR non generato | Session corrotta | Cancellare session, riconnettere |
| Disconnessioni frequenti | Rate limit o IP ban | Aumentare delay, verificare proxy |
| Media non inviati | FFmpeg mancante o errore | Verificare installazione FFmpeg |
| Messaggi non ricevuti | Webhook non configurato | Verificare configurazione eventi |
