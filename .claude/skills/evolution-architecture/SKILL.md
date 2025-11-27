# Evolution Architecture - Architettura Core

## Descrizione
Architettura core di Evolution API: Service Layer Pattern, RouterBroker, Dependency Injection, e convenzioni di progetto. Base fondamentale per comprendere come i componenti comunicano e come aggiungere nuove funzionalità.

## Quando Usare
- Creare nuovi controller, service, o router
- Aggiungere nuovi endpoint API
- Capire il flusso di una richiesta HTTP
- Implementare nuove integrazioni
- Modificare dependency injection
- Comprendere convenzioni di naming e struttura

## Pattern Principali

### Service Layer Pattern
```
HTTP Request → Router → Controller → Service → Repository → Database
                                        ↓
                                   External APIs
```

| Layer | Responsabilità | File Location |
|-------|----------------|---------------|
| Router | Validazione input, routing | `src/api/routes/*.router.ts` |
| Controller | Orchestrazione, thin layer | `src/api/controllers/*.controller.ts` |
| Service | Business logic, core | `src/api/services/*.service.ts` |
| Repository | Data access, Prisma | `src/api/repository/*.service.ts` |

### RouterBroker Pattern
**File**: `src/api/abstract/abstract.router.ts`

Pattern per validazione + esecuzione in routes:

```typescript
// Pattern standard per endpoint
router.post(this.routerPath('create'), ...guards, async (req, res) => {
  const response = await this.dataValidate<CreateDto>({
    request: req,
    schema: createSchema,  // JSONSchema7
    ClassRef: CreateDto,
    execute: (instance, data) => controller.create(instance, data),
  });
  res.status(HttpStatus.OK).json(response);
});
```

**Componenti**:
- `routerPath()`: Costruisce path con instanceName
- `dataValidate<T>()`: Valida input e esegue handler
- `schema`: JSONSchema7 per validazione
- `ClassRef`: DTO class per type safety

### Dependency Injection
**File**: `src/api/server.module.ts`

Container DI manuale (no framework):

```typescript
// Istanze singleton esportate
export const prismaRepository = new PrismaRepository();
export const waMonitor = new WAMonitoringService();
export const cacheService = new CacheService();
// ... altri servizi
```

**Import pattern**:
```typescript
import { prismaRepository, waMonitor } from '@api/server.module';
```

### Guard Middleware
**File**: `src/api/guards/`

| Guard | Scopo | File |
|-------|-------|------|
| `authGuard['apikey']` | Autenticazione API key | `auth.guard.ts` |
| `instanceExistsGuard` | Verifica esistenza istanza | `instance.guard.ts` |
| `instanceLoggedGuard` | Verifica istanza connessa | `instance.guard.ts` |
| `Telemetry` | Raccolta metriche | `telemetry.guard.ts` |

**Ordine standard**: `[instanceExistsGuard, instanceLoggedGuard, authGuard['apikey']]`

### File Structure Conventions
```
src/
├── api/
│   ├── controllers/     # Thin orchestration layer
│   ├── services/        # Business logic (CORE)
│   ├── repository/      # Data access
│   ├── dto/            # Data Transfer Objects
│   ├── guards/         # Auth/validation middleware
│   ├── routes/         # HTTP route definitions
│   ├── integrations/   # External services
│   │   ├── channel/    # WhatsApp providers
│   │   ├── chatbot/    # Bot integrations
│   │   ├── event/      # Event transports
│   │   └── storage/    # File storage
│   └── types/          # TypeScript types
├── config/             # Configuration
├── cache/             # Caching
├── exceptions/        # Custom exceptions
├── utils/            # Utilities
├── validate/         # JSONSchema7 schemas
└── watchdog/         # External watchdog process
```

### Naming Conventions
| Elemento | Convention | Esempio |
|----------|------------|---------|
| Classi | PascalCase | `InstanceService` |
| Metodi | camelCase | `createInstance()` |
| File service | `*.service.ts` | `instance.service.ts` |
| File controller | `*.controller.ts` | `instance.controller.ts` |
| File router | `*.router.ts` | `instance.router.ts` |
| File DTO | `*.dto.ts` | `instance.dto.ts` |
| File schema | `*.schema.ts` | `instance.schema.ts` |

### Integration Pattern
Ogni integrazione segue struttura:
```
integrations/
└── [category]/
    └── [provider]/
        ├── [provider].router.ts
        ├── [provider].controller.ts
        ├── [provider].service.ts
        ├── [provider].schema.ts
        └── dto/
```

## File Critici
- `src/api/server.module.ts` - DI container, istanze singleton
- `src/api/abstract/abstract.router.ts` - RouterBroker base class
- `src/main.ts` - Bootstrap applicazione
- `src/config/env.config.ts` - Configurazione tipizzata
- `src/api/routes/index.router.ts` - Route registration

## Best Practices

### DO (Fare)
- Business logic SEMPRE nei services, mai nei controller
- Usare `dataValidate<T>()` per tutti gli endpoint
- Seguire naming conventions del progetto
- Importare servizi da `server.module.ts`
- Usare JSONSchema7 per validazione (NO class-validator)
- Mantenere controller sottili (thin controllers)

### DON'T (Non fare)
- MAI mettere business logic nei controller o router
- MAI creare nuove istanze di servizi singleton
- MAI usare class-validator (progetto usa JSONSchema7)
- MAI bypassare il sistema di guards
- MAI hardcodare configurazioni (usare env.config)
- MAI aggiungere dipendenze circolari tra moduli
