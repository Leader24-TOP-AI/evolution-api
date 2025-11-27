# Chatbot Integrations - 8 Piattaforme Bot

## Descrizione
Sistema di integrazione chatbot che supporta 8 piattaforme diverse. Pattern comune BaseChatbotService per gestione sessioni, trigger, e messaggi. Ogni bot ha configurazione per-instance.

## Quando Usare
- Aggiungere nuovo tipo di chatbot
- Modificare logica bot esistenti
- Debug sessioni chatbot
- Implementare nuovi trigger
- Gestire audio transcription
- Modificare flow di messaggi bot

## Pattern Principali

### 8 Piattaforme Supportate
| Bot | Descrizione | Use Case |
|-----|-------------|----------|
| **OpenAI** | GPT + Whisper | AI conversazionale, transcription |
| **Typebot** | Flow builder visuale | Bot senza codice |
| **Dify** | AI agent platform | Workflow AI complessi |
| **Flowise** | LangChain visual | RAG, chains |
| **N8N** | Workflow automation | Automazioni |
| **EvolutionBot** | Native bot | Bot semplici con trigger |
| **EvoAI** | Custom AI | AI personalizzata |
| **Chatwoot** | Customer service | Support ticketing |

### BaseChatbotService Pattern
**File**: `src/api/integrations/chatbot/base-chatbot.service.ts`

Classe base astratta che tutti i bot estendono:

```typescript
abstract class BaseChatbotService {
  // Gestione sessione
  abstract createSession(data): Promise<Session>;
  abstract processMessage(session, message): Promise<Response>;
  abstract closeSession(sessionId): Promise<void>;

  // Utility comuni
  protected sendMessageWhatsApp(instance, message): Promise<void>;
  protected splitMessages(text, maxLength): string[];
}
```

### Session Lifecycle
```
Trigger Match → Create Session → Process Messages → Close Session
      ↓              ↓                  ↓               ↓
  findBotByTrigger  DB persist      Bot API call    Cleanup
```

**Stati sessione**:
| Stato | Descrizione |
|-------|-------------|
| `active` | Sessione in corso |
| `paused` | Temporaneamente sospesa |
| `closed` | Terminata |

### Bot Triggering Flow
**File**: `src/api/integrations/chatbot/chatbot.controller.ts`

```
Messaggio WhatsApp
       ↓
chatbotController.emit()
       ↓
findBotByTrigger() → Match trigger keywords
       ↓
botService.processMessage()
       ↓
sendMessageWhatsApp() → Risposta
```

### findBotByTrigger Utility
Cerca bot configurato che matcha il messaggio:

```typescript
// Ordine di priorità matching
1. Exact match keyword
2. Regex pattern match
3. Default bot (se configurato)
```

### Message Sending Patterns
```typescript
// Invio singolo messaggio
await this.sendMessageWhatsApp(instance, {
  number: remoteJid,
  text: response,
});

// Split messaggi lunghi
const chunks = this.splitMessages(longText, 4000);
for (const chunk of chunks) {
  await this.sendMessageWhatsApp(instance, { text: chunk });
}
```

### Audio Transcription (Whisper)
**File**: `src/api/integrations/chatbot/openai/services/openai.service.ts`

```
Audio Message → Download → Whisper API → Text → Bot Processing
```

Supporta: OGG, MP3, WAV, M4A

### Configurazione Per-Instance
Ogni istanza può avere bot diversi configurati:

```typescript
// Database: Typebot, Dify, OpenAI, etc.
{
  instanceId: 'uuid',
  botType: 'typebot',
  enabled: true,
  triggerType: 'keyword',  // keyword, all, none
  triggerValue: 'help',
  // ... bot-specific config
}
```

## File Critici
- `src/api/integrations/chatbot/base-chatbot.service.ts` - Base class
- `src/api/integrations/chatbot/chatbot.controller.ts` - Orchestrazione
- `src/api/integrations/chatbot/[bot]/services/*.service.ts` - Implementazioni specifiche
- `src/api/integrations/chatbot/[bot]/routes/*.router.ts` - Route configurazione

## Struttura Directory Chatbot
```
chatbot/
├── base-chatbot.service.ts    # Base astratta
├── chatbot.controller.ts      # Controller principale
├── chatbot.router.ts          # Router aggregato
├── openai/
│   ├── dto/
│   ├── routes/
│   └── services/
├── typebot/
│   ├── dto/
│   ├── routes/
│   └── services/
├── dify/
├── flowise/
├── n8n/
├── evolutionBot/
├── evoai/
└── chatwoot/
```

## Best Practices

### DO (Fare)
- SEMPRE estendere BaseChatbotService per nuovi bot
- SEMPRE gestire session lifecycle completo
- SEMPRE usare splitMessages per testi lunghi
- Implementare timeout per chiamate API bot
- Gestire errori gracefully con fallback message
- Loggare interazioni per debug

### DON'T (Non fare)
- MAI bloccare il thread con chiamate sync a bot API
- MAI salvare dati sensibili utente nei log
- MAI ignorare session cleanup (memory leak)
- MAI inviare messaggi senza rate limiting
- MAI hardcodare credenziali bot
- MAI bypassare il sistema di trigger

### Aggiungere Nuovo Bot
1. Creare directory in `chatbot/[newbot]/`
2. Implementare service estendendo `BaseChatbotService`
3. Creare router con endpoint configurazione
4. Aggiungere schema Prisma se necessario
5. Registrare in `chatbot.router.ts`
6. Aggiungere a `findBotByTrigger()`
