# Event System - 7 Transport Events

## Descrizione
Sistema eventi che supporta 7 transport diversi per notificare eventi WhatsApp a sistemi esterni. EventManager orchestra l'emissione parallela a tutti i transport configurati per-instance.

## Quando Usare
- Configurare webhook per istanza
- Aggiungere nuovo event transport
- Debug eventi non ricevuti
- Modificare formato eventi
- Implementare filtering eventi

## Pattern Principali

### 7 Transport Supportati
| Transport | Protocollo | Use Case |
|-----------|------------|----------|
| **WebSocket** | Socket.io | Real-time UI |
| **Webhook** | HTTP POST | Integrazioni esterne |
| **RabbitMQ** | AMQP | Message queue |
| **NATS** | NATS | High-performance messaging |
| **SQS** | AWS SQS | Cloud queue |
| **Pusher** | Pusher | Push notifications |
| **Kafka** | Kafka | Event streaming |

### EventManager Architecture
**File**: `src/api/integrations/event/event.manager.ts`

```
WhatsApp Event
      ↓
EventManager.emit()
      ↓
┌─────────────────────────────────────────┐
│  Parallel dispatch a tutti i transport  │
│  ┌───────┐ ┌───────┐ ┌───────┐         │
│  │WebSocket│ │Webhook│ │RabbitMQ│ ...    │
│  └───────┘ └───────┘ └───────┘         │
└─────────────────────────────────────────┘
```

### Event Types (30+ eventi)
| Categoria | Eventi |
|-----------|--------|
| **Connection** | `connection.update`, `qrcode.updated` |
| **Messages** | `messages.upsert`, `messages.update`, `messages.delete` |
| **Contacts** | `contacts.upsert`, `contacts.update` |
| **Groups** | `groups.upsert`, `groups.update`, `group-participants.update` |
| **Chats** | `chats.upsert`, `chats.update`, `chats.delete` |
| **Presence** | `presence.update` |
| **Labels** | `labels.edit`, `labels.association` |
| **Calls** | `call` |

### emit() Flow
```typescript
// EventManager emette a tutti i transport
async emit(event: string, instanceName: string, data: any) {
  const transports = this.getActiveTransports(instanceName);

  // Emissione parallela
  await Promise.allSettled(
    transports.map(t => t.send(event, data))
  );
}
```

### Per-Instance Configuration
Ogni istanza può configurare:
- Quali eventi ricevere
- Quali transport usare
- Endpoint/credenziali specifiche

```typescript
// Database config per instance
{
  instanceId: 'uuid',
  events: ['messages.upsert', 'connection.update'],
  webhook: {
    url: 'https://example.com/webhook',
    enabled: true
  },
  websocket: { enabled: true },
  rabbitmq: { enabled: false }
}
```

### WebSocket Namespace
**File**: `src/api/integrations/event/websocket/websocket.service.ts`

```typescript
// Namespace per instance
io.of(`/${instanceName}`).emit(event, data);

// Client connection
const socket = io('http://server:port/instanceName');
socket.on('messages.upsert', (data) => { ... });
```

### Webhook Format
```typescript
// POST to webhook URL
{
  event: 'messages.upsert',
  instance: 'instanceName',
  data: {
    // Event-specific payload
  },
  date_time: '2024-01-01T00:00:00.000Z',
  sender: 'Evolution API'
}
```

### Event Filtering
```typescript
// Solo eventi configurati vengono emessi
const allowedEvents = instance.webhook.events;
if (allowedEvents.includes(event)) {
  await this.emit(event, data);
}
```

## File Critici
- `src/api/integrations/event/event.manager.ts` - Manager principale
- `src/api/integrations/event/event.router.ts` - Route configurazione
- `src/api/integrations/event/websocket/` - WebSocket transport
- `src/api/integrations/event/webhook/` - HTTP webhook
- `src/api/integrations/event/rabbitmq/` - RabbitMQ transport
- `src/api/integrations/event/sqs/` - AWS SQS
- `src/api/integrations/event/nats/` - NATS
- `src/api/integrations/event/pusher/` - Pusher
- `src/api/integrations/event/kafka/` - Kafka

## Struttura Directory
```
event/
├── event.manager.ts       # Orchestrazione
├── event.router.ts        # Route aggregate
├── websocket/
│   ├── websocket.router.ts
│   └── websocket.service.ts
├── webhook/
│   ├── webhook.router.ts
│   └── webhook.service.ts
├── rabbitmq/
├── sqs/
├── nats/
├── pusher/
└── kafka/
```

## Best Practices

### DO (Fare)
- SEMPRE usare `Promise.allSettled` per emissione parallela
- SEMPRE loggare errori di delivery
- Implementare retry per transport critici (webhook)
- Validare payload prima di emettere
- Usare filtering per ridurre traffico inutile

### DON'T (Non fare)
- MAI bloccare su singolo transport fallito
- MAI inviare eventi non richiesti (rispettare config)
- MAI esporre dati sensibili negli eventi
- MAI ignorare errori di connessione transport
- MAI hardcodare endpoint transport

### Aggiungere Nuovo Transport
1. Creare directory `event/[newtransport]/`
2. Implementare service con metodo `send(event, data)`
3. Creare router per configurazione
4. Registrare in `EventManager`
5. Aggiungere schema Prisma per config
6. Documentare in API docs
