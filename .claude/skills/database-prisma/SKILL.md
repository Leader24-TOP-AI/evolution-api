# Database Prisma - Multi-Provider DB

## Descrizione
Gestione database multi-provider (PostgreSQL, MySQL) tramite Prisma ORM. Schema separati per provider, migration workflow, e pattern di query con timeout protection.

## Quando Usare
- Modificare schema database
- Aggiungere nuove migration
- Scrivere query complesse
- Debug problemi database
- Ottimizzare performance query
- Cambiare provider database

## IMPORTANTE: File .env
**SEMPRE leggere le variabili dal file `.env` nella root del progetto!**

```bash
# Variabili critiche in .env
DATABASE_PROVIDER=postgresql        # o mysql
DATABASE_CONNECTION_URI=postgresql://user:pass@host:5432/db
DATABASE_CONNECTION_CLIENT_NAME=evolution_api
```

**Prima di operazioni database**:
```bash
# Verificare provider attivo
source .env && echo $DATABASE_PROVIDER

# Verificare connessione
source .env && echo $DATABASE_CONNECTION_URI
```

## Pattern Principali

### Multi-Provider Support
| Provider | Schema File | Migration Folder |
|----------|-------------|------------------|
| PostgreSQL | `prisma/postgresql-schema.prisma` | `prisma/migrations/` |
| MySQL | `prisma/mysql-schema.prisma` | `prisma/mysql-migrations/` |

**Selezione automatica** basata su `DATABASE_PROVIDER` env var.

### Schema Files Location
```
prisma/
├── postgresql-schema.prisma    # Schema PostgreSQL
├── mysql-schema.prisma         # Schema MySQL
├── migrations/                 # PostgreSQL migrations
└── mysql-migrations/           # MySQL migrations
```

### Migration Workflow
```bash
# 1. SEMPRE settare provider prima
export DATABASE_PROVIDER=postgresql

# 2. Generare Prisma client
npm run db:generate

# 3. Creare migration (development)
npm run db:migrate:dev

# 4. Applicare migration (production)
npm run db:deploy
```

**Script npm**:
| Comando | Azione |
|---------|--------|
| `db:generate` | Genera Prisma client |
| `db:deploy` | Applica migration (prod) |
| `db:migrate:dev` | Crea + applica migration (dev) |
| `db:studio` | Apre Prisma Studio GUI |

### PrismaRepository Pattern
**File**: `src/api/repository/repository.service.ts`

```typescript
// Repository estende PrismaClient
export class PrismaRepository extends PrismaClient {
  constructor() {
    super({
      datasources: {
        db: { url: process.env.DATABASE_CONNECTION_URI }
      }
    });
  }
}
```

### Key Entities
| Entity | Descrizione |
|--------|-------------|
| `Instance` | Istanza WhatsApp |
| `Message` | Messaggi inviati/ricevuti |
| `Chat` | Conversazioni |
| `Contact` | Contatti |
| `WatchdogHeartbeat` | Heartbeat per monitoring |
| `HealthEvent` | Eventi salute sistema |
| `Session` | Sessioni chatbot |
| `Webhook` | Configurazioni webhook |
| `Typebot`, `OpenAI`, etc. | Config per ogni bot |

### Query Pattern con Timeout
**SEMPRE** wrappare query con `withDbTimeout`:

```typescript
import { withDbTimeout } from '@utils/async-timeout';

// Query singola
const instance = await withDbTimeout(
  prisma.instance.findUnique({ where: { name } }),
  'findInstance'
);

// Query multipla
const instances = await withDbTimeout(
  prisma.instance.findMany({
    where: { status: 'active' },
    include: { webhook: true }
  }),
  'findActiveInstances'
);

// Transaction
const result = await withDbTimeout(
  prisma.$transaction([
    prisma.instance.update({ ... }),
    prisma.message.create({ ... })
  ]),
  'instanceTransaction'
);
```

### Connection Management
```typescript
// Connect con timeout
await withDbTimeout(prisma.$connect(), 'dbConnect');

// Disconnect con timeout
await withDbTimeout(prisma.$disconnect(), 'dbDisconnect');
```

### Common Query Patterns
```typescript
// FindUnique con relation
prisma.instance.findUnique({
  where: { name: instanceName },
  include: {
    webhook: true,
    chatwoot: true,
  }
});

// FindMany con filtri
prisma.message.findMany({
  where: {
    instanceId: id,
    createdAt: { gte: startDate }
  },
  orderBy: { createdAt: 'desc' },
  take: 100
});

// Upsert
prisma.contact.upsert({
  where: { remoteJid_instanceId: { remoteJid, instanceId } },
  create: { ... },
  update: { ... }
});
```

## File Critici
- `prisma/postgresql-schema.prisma` - Schema PostgreSQL
- `prisma/mysql-schema.prisma` - Schema MySQL
- `src/api/repository/repository.service.ts` - PrismaRepository class
- `.env` - **DATABASE_PROVIDER e DATABASE_CONNECTION_URI**

## Best Practices

### DO (Fare)
- SEMPRE leggere DATABASE_PROVIDER da .env
- SEMPRE wrappare query con `withDbTimeout()`
- SEMPRE usare transaction per operazioni multiple correlate
- Usare `include` invece di query separate per relations
- Indicizzare campi usati frequentemente in WHERE
- Usare `select` per limitare campi quando possibile

### DON'T (Non fare)
- MAI hardcodare connection string
- MAI fare query senza timeout
- MAI modificare schema senza migration
- MAI usare `findMany()` senza `take` limit su tabelle grandi
- MAI ignorare errori di connessione
- MAI fare N+1 queries (usare include/join)

### Troubleshooting
| Problema | Causa | Soluzione |
|----------|-------|-----------|
| Connection timeout | DB sovraccarico | Aumentare pool, verificare indici |
| Migration failed | Schema conflict | Verificare pending migrations |
| Type mismatch | Schema outdated | `npm run db:generate` |
| Slow queries | Missing index | Aggiungere indice in schema |
