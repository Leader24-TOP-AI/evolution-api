# Validation & Error Handling - Validazione e Gestione Errori

## Descrizione
Sistema di validazione input tramite JSONSchema7 e gestione errori standardizzata. Ogni endpoint usa RouterBroker.dataValidate() per validazione, e exceptions custom per errori HTTP.

## Quando Usare
- Creare nuovi endpoint API
- Definire nuovi DTO (Data Transfer Objects)
- Creare schemi di validazione
- Gestire errori in modo consistente
- Implementare error response standardizzate

## Pattern Principali

### JSONSchema7 Validation
**IMPORTANTE**: Il progetto usa JSONSchema7, NON class-validator!

**File schema**: `src/validate/*.schema.ts`

```typescript
// Schema definition
export const createInstanceSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    instanceName: { type: 'string', minLength: 1 },
    token: { type: 'string' },
    number: { type: 'string', pattern: '^[0-9]+$' },
  },
  required: ['instanceName'],
};
```

**Tipi comuni**:
| Tipo | Validazione |
|------|-------------|
| `string` | `minLength`, `maxLength`, `pattern`, `enum` |
| `number` | `minimum`, `maximum` |
| `boolean` | true/false |
| `array` | `items`, `minItems`, `maxItems` |
| `object` | `properties`, `required`, `additionalProperties` |

### RouterBroker.dataValidate Pattern
```typescript
const response = await this.dataValidate<CreateInstanceDto>({
  request: req,
  schema: createInstanceSchema,  // JSONSchema7
  ClassRef: CreateInstanceDto,   // DTO class
  execute: (instance, data) => controller.create(instance, data),
});
```

**Flusso**:
1. Estrae `instanceName` da params
2. Valida body contro schema
3. Crea istanza DTO
4. Esegue handler se validazione passa
5. Ritorna errore 400 se validazione fallisce

### DTO Pattern
**File**: `src/api/dto/*.dto.ts`

```typescript
// DTO semplice
export class InstanceDto {
  instanceName: string;
}

// DTO con inheritance
export class CreateInstanceDto extends InstanceDto {
  token?: string;
  number?: string;
  integration?: string;
}
```

**Convenzioni**:
- Classi semplici, no decoratori
- Proprietà opzionali con `?`
- Extends per riuso

### Custom Exceptions
**File**: `src/exceptions/*.ts`

| Exception | HTTP Code | Uso |
|-----------|-----------|-----|
| `BadRequestException` | 400 | Input non valido |
| `UnauthorizedException` | 401 | Auth mancante/invalida |
| `ForbiddenException` | 403 | Permessi insufficienti |
| `NotFoundException` | 404 | Risorsa non trovata |
| `InternalServerErrorException` | 500 | Errore server |

**Pattern d'uso**:
```typescript
import { NotFoundException, BadRequestException } from '@exceptions';

// Nel service
if (!instance) {
  throw new NotFoundException('Instance not found');
}

if (!data.instanceName) {
  throw new BadRequestException('instanceName is required');
}
```

### Global Error Handler
**File**: `src/main.ts`

Cattura tutte le eccezioni non gestite e formatta risposta:

```typescript
// Response format
{
  "status": 400,
  "error": "Bad Request",
  "message": "Validation failed: instanceName is required"
}
```

### Error Response Format
```typescript
interface ErrorResponse {
  status: number;      // HTTP status code
  error: string;       // Error type name
  message: string;     // Human-readable message
  details?: any;       // Optional additional info
}
```

### Webhook Error Notification
Errori critici vengono inviati via webhook se configurato:
- Connection errors
- Auth failures
- Critical exceptions

## File Critici
- `src/validate/*.schema.ts` - Schemi JSONSchema7
- `src/api/dto/*.dto.ts` - Data Transfer Objects
- `src/exceptions/*.ts` - Custom exceptions
- `src/api/abstract/abstract.router.ts` - dataValidate implementation
- `src/main.ts` - Global error handler

## Best Practices

### DO (Fare)
- SEMPRE usare JSONSchema7 per validazione
- SEMPRE usare `dataValidate<T>()` negli endpoint
- SEMPRE usare exceptions custom per errori HTTP
- Definire schema separato per ogni endpoint
- Messaggi di errore chiari e utili
- Validare tutti i campi required nello schema

### DON'T (Non fare)
- MAI usare class-validator (non è pattern del progetto)
- MAI lanciare Error generici - usare exceptions custom
- MAI esporre stack trace in produzione
- MAI validare manualmente quando schema può farlo
- MAI ignorare errori - sempre gestire o propagare
- MAI hardcodare messaggi di errore ripetuti

### Schema Patterns Comuni
```typescript
// String con pattern
{ type: 'string', pattern: '^[0-9]+$' }

// Enum
{ type: 'string', enum: ['option1', 'option2'] }

// Array di oggetti
{
  type: 'array',
  items: {
    type: 'object',
    properties: { ... }
  }
}

// Oggetto nested
{
  type: 'object',
  properties: {
    nested: {
      type: 'object',
      properties: { ... }
    }
  }
}
```
