# CLAUDE.md

This file provides comprehensive guidance to Claude AI when working with the Evolution API codebase.

---

## IMPORTANT NOTES FOR CLAUDE

### GitHub Fork - DO NOT PUSH MULTIPLE TIMES
- This repository is a **FORK** at `github.com/Leader24-TOP-AI/evolution-api`
- **CONSOLIDATE changes into single commits** before pushing
- Always **verify push succeeded** before attempting again
- If push fails, diagnose the issue first - don't retry blindly

### Translations Required - ALWAYS ADD ALL LANGUAGES
When creating new UI text, **ALWAYS** add translations to ALL languages:

**Frontend (5 languages)** - `evolution-manager-v2/src/translate/languages/`:
| File | Language | Notes |
|------|----------|-------|
| `it-IT.json` | Italian | **DEFAULT** - Start here |
| `en-US.json` | English | |
| `pt-BR.json` | Portuguese (Brazil) | |
| `es-ES.json` | Spanish | |
| `fr-FR.json` | French | |

**Backend (3 languages)** - `src/utils/translations/` - Only for Chatwoot messages:
| File | Language |
|------|----------|
| `en.json` | English |
| `pt-BR.json` | Portuguese |
| `es.json` | Spanish |

### Use Ultrathink for Deep Analysis
When analyzing complex issues or debugging system problems, use extended thinking mode for thorough analysis.

---

## Project Overview

**Evolution API** is a powerful, production-ready REST API for WhatsApp communication that supports multiple WhatsApp providers:
- **Baileys** (WhatsApp Web) - Open-source WhatsApp Web client
- **Meta Business API** - Official WhatsApp Business API
- **Evolution API** - Custom WhatsApp integration

Built with **Node.js 20+**, **TypeScript 5+**, and **Express.js**, it provides extensive integrations with chatbots, CRM systems, and messaging platforms in a **multi-tenant architecture**.

## Common Development Commands

### Build and Run
```bash
# Development
npm run dev:server    # Run in development with hot reload (tsx watch)

# Production
npm run build        # TypeScript check + tsup build
npm run start:prod   # Run production build

# Direct execution
npm start           # Run with tsx
```

### Code Quality
```bash
npm run lint        # ESLint with auto-fix
npm run lint:check  # ESLint check only
npm run commit      # Interactive commit with commitizen
```

### Database Management
```bash
# Set database provider first
export DATABASE_PROVIDER=postgresql  # or mysql

# Generate Prisma client (automatically uses DATABASE_PROVIDER env)
npm run db:generate

# Deploy migrations (production)
npm run db:deploy      # Unix/Mac
npm run db:deploy:win  # Windows

# Development migrations (with sync to provider folder)
npm run db:migrate:dev      # Unix/Mac
npm run db:migrate:dev:win  # Windows

# Open Prisma Studio
npm run db:studio

# Development migrations
npm run db:migrate:dev      # Unix/Mac
npm run db:migrate:dev:win  # Windows
```

### Testing
```bash
npm test    # Run tests with watch mode
```

## Architecture Overview

### Core Structure
- **Multi-tenant SaaS**: Complete instance isolation with per-tenant authentication
- **Multi-provider database**: PostgreSQL and MySQL via Prisma ORM with provider-specific schemas and migrations
- **WhatsApp integrations**: Baileys, Meta Business API, and Evolution API with unified interface
- **Event-driven architecture**: EventEmitter2 for internal events + WebSocket, RabbitMQ, SQS, NATS, Pusher for external events
- **Microservices pattern**: Modular integrations for chatbots, storage, and external services

### Directory Layout
```
src/
├── api/
│   ├── controllers/     # HTTP route handlers (thin layer)
│   ├── services/        # Business logic (core functionality)
│   ├── repository/      # Data access layer (Prisma)
│   ├── dto/            # Data Transfer Objects (simple classes)
│   ├── guards/         # Authentication/authorization middleware
│   ├── integrations/   # External service integrations
│   │   ├── channel/    # WhatsApp providers (Baileys, Business API, Evolution)
│   │   ├── chatbot/    # AI/Bot integrations (OpenAI, Dify, Typebot, Chatwoot)
│   │   ├── event/      # Event systems (WebSocket, RabbitMQ, SQS, NATS, Pusher)
│   │   └── storage/    # File storage (S3, MinIO)
│   ├── routes/         # Express route definitions (RouterBroker pattern)
│   └── types/          # TypeScript type definitions
├── config/             # Environment and app configuration
├── cache/             # Redis and local cache implementations
├── exceptions/        # Custom HTTP exception classes
├── utils/            # Shared utilities and helpers
└── validate/         # JSONSchema7 validation schemas
```

### Key Integration Points

**Channel Integrations** (`src/api/integrations/channel/`):
- **Baileys**: WhatsApp Web client with QR code authentication
- **Business API**: Official Meta WhatsApp Business API
- **Evolution API**: Custom WhatsApp integration
- Connection lifecycle management per instance with automatic reconnection

**Chatbot Integrations** (`src/api/integrations/chatbot/`):
- **EvolutionBot**: Native chatbot with trigger system
- **Chatwoot**: Customer service platform integration
- **Typebot**: Visual chatbot flow builder
- **OpenAI**: AI capabilities including GPT and Whisper (audio transcription)
- **Dify**: AI agent workflow platform
- **Flowise**: LangChain visual builder
- **N8N**: Workflow automation platform
- **EvoAI**: Custom AI integration

**Event Integrations** (`src/api/integrations/event/`):
- **WebSocket**: Real-time Socket.io connections
- **RabbitMQ**: Message queue for async processing
- **Amazon SQS**: Cloud-based message queuing
- **NATS**: High-performance messaging system
- **Pusher**: Real-time push notifications

**Storage Integrations** (`src/api/integrations/storage/`):
- **AWS S3**: Cloud object storage
- **MinIO**: Self-hosted S3-compatible storage
- Media file management and URL generation

---

## Defense in Depth Architecture

A multi-layered protection system to prevent and recover from WhatsApp instance freezing/hanging.

### Layer 1: Timeout Protection (Immediate)
**File**: `src/utils/async-timeout.ts`

Wraps all async operations with configurable timeouts:
| Operation Type | Timeout | Description |
|----------------|---------|-------------|
| Database queries | 5000ms | Prisma operations |
| Redis operations | 3000ms | Cache read/write |
| WebSocket events | 2000ms | Socket communication |
| HTTP requests | 10000ms | External API calls |

```typescript
// Usage example
const result = await withTimeout(
  prisma.instance.findMany(),
  TIMEOUT_DEFAULTS.DATABASE,
  'fetch instances'
);
```

### Layer 2: Circuit Breaker (Prevention)
**File**: `src/utils/circuit-breaker.ts`

Prevents cascade failures with state machine pattern:
```
CLOSED → OPEN (after 5 failures) → HALF_OPEN (after 60s) → CLOSED (after 2 successes)
     ↑                                                              ↓
     └──────────────────────────────────────────────────────────────┘
```

| State | Behavior |
|-------|----------|
| CLOSED | Normal operation, tracking failures |
| OPEN | All requests fail fast, no actual execution |
| HALF_OPEN | Testing recovery with limited requests |

**Per-Instance Circuits**: Each WhatsApp instance has its own circuit breaker to isolate failures.

### Layer 3: External Watchdog (Recovery)
**Files**: `src/watchdog/watchdog.service.ts`, `src/watchdog/index.ts`

Runs as **SEPARATE PM2 process** - can recover even if main process is frozen:

**Detection Methods**:
| Issue | Detection Time | Trigger |
|-------|---------------|---------|
| Stale heartbeat | 90 seconds | No heartbeat update |
| Stuck connecting | 120 seconds | In 'connecting' state too long |
| Circuit stuck OPEN | - | Logged, not auto-recovered |

**Recovery Escalation**:
1. **API Restart** (attempts 1-2): Gentle restart via REST API
2. **DB Flag** (attempts 3-5): Force reconnection via database flag
3. **PM2 Restart** (attempt 6+): Nuclear option, restart entire process

### Resource Registry (Cleanup)
**File**: `src/utils/resource-registry.ts`

Centralized tracking for all resources to prevent memory leaks:
- Timers (setTimeout/setInterval)
- Event listeners
- Child processes (FFmpeg, etc.)
- `cleanupAll()` method for emergency cleanup

### Database Tables
| Table | Purpose |
|-------|---------|
| `WatchdogHeartbeat` | Per-instance health tracking (lastHeartbeat, state, recoveryAttempts) |
| `HealthEvent` | Recovery event logging (eventType, severity, message, details) |

### PM2 Configuration
**File**: `ecosystem.config.js`
```javascript
apps: [
  { name: 'evolution-api', script: 'dist/main.js', instances: 1 },
  { name: 'evolution-watchdog', script: 'dist/watchdog/index.js', instances: 1 }
]
```

### Monitoring Commands
```bash
# View both processes
pm2 list

# Watchdog logs
pm2 logs evolution-watchdog

# Debug mode (verbose logging)
WATCHDOG_DEBUG=true pm2 restart evolution-watchdog
```

---

### Database Schema Management
- Separate schema files: `postgresql-schema.prisma` and `mysql-schema.prisma`
- Environment variable `DATABASE_PROVIDER` determines active database
- Migration folders are provider-specific and auto-selected during deployment

### Authentication & Security
- **API key-based authentication** via `apikey` header (global or per-instance)
- **Instance-specific tokens** for WhatsApp connection authentication
- **Guards system** for route protection and authorization
- **Input validation** using JSONSchema7 with RouterBroker `dataValidate`
- **Rate limiting** and security middleware
- **Webhook signature validation** for external integrations

## Important Implementation Details

### WhatsApp Instance Management
- Each WhatsApp connection is an "instance" with unique name
- Instance data stored in database with connection state
- Session persistence in database or file system (configurable)
- Automatic reconnection handling with exponential backoff

### Message Queue Architecture
- Supports RabbitMQ, Amazon SQS, and WebSocket for events
- Event types: message.received, message.sent, connection.update, etc.
- Configurable per instance which events to send

### Media Handling
- Local storage or S3/Minio for media files
- Automatic media download from WhatsApp
- Media URL generation for external access
- Support for audio transcription via OpenAI

---

## Translation System

### Frontend i18n (React)
**Location**: `evolution-manager-v2/src/translate/`

**Available Languages**:
| Code | Language | File |
|------|----------|------|
| `it-IT` | Italian | `languages/it-IT.json` (DEFAULT) |
| `en-US` | English | `languages/en-US.json` |
| `pt-BR` | Portuguese | `languages/pt-BR.json` |
| `es-ES` | Spanish | `languages/es-ES.json` |
| `fr-FR` | French | `languages/fr-FR.json` |

**Usage Pattern**:
```typescript
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t } = useTranslation();
  return <h1>{t('dashboard.title')}</h1>;
}
```

**Key Naming Convention**:
```json
{
  "section": {
    "subsection": {
      "key": "Value",
      "keyWithVar": "Hello {{name}}"
    }
  }
}
```

| Pattern | Example | Usage |
|---------|---------|-------|
| `section.title` | `dashboard.title` | Section headers |
| `button.action` | `button.save`, `button.cancel` | Button labels |
| `button.actionLoading` | `button.saving` | Loading states |
| `toast.type.context` | `toast.success.saved` | Notifications |
| `form.field.type` | `form.email.placeholder` | Form fields |
| `table.column` | `table.name`, `table.status` | Table headers |

### Backend i18n (Node.js)
**Location**: `src/utils/translations/`

Used for Chatwoot integration messages:
| File | Language |
|------|----------|
| `en.json` | English |
| `pt-BR.json` | Portuguese |
| `es.json` | Spanish |

**Usage Pattern**:
```typescript
import i18next from 'i18next';

const message = i18next.t('chatwoot.welcome_message');
```

### Adding New Translations Checklist
1. Add key to **ALL 5** frontend language files
2. Start with `it-IT.json` (default language)
3. Use hierarchical naming (`section.subsection.key`)
4. Use `{{variable}}` syntax for dynamic values
5. Keep translations consistent across languages
6. Test UI in all languages if possible

---

### Multi-tenancy Support
- Instance isolation at database level
- Separate webhook configurations per instance
- Independent integration settings per instance

---

## Health Monitor Dashboard

### Overview
Real-time monitoring dashboard for WhatsApp instances and system health.

**Backend**: `src/api/services/health-monitor.service.ts`
**Frontend**: `evolution-manager-v2/src/pages/HealthMonitorDashboard/`
**Route**: `/health-monitor` in the manager UI

### API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health-monitor/dashboard` | Complete dashboard data |
| GET | `/health-monitor/instances` | All instances health status |
| GET | `/health-monitor/system` | System health metrics |
| GET | `/health-monitor/events` | Recent health events |
| POST | `/health-monitor/circuit-breaker/reset/:name` | Reset a circuit breaker |

### Health Score Calculation (0-100)
Each instance starts at 100 and receives penalties:

| Condition | Penalty | Detection |
|-----------|---------|-----------|
| Connection closed | -30 | `connectionStatus === 'close'` |
| No heartbeat >90s | -40 | `lastHeartbeat` age check |
| Stuck connecting >120s | -30 | `stuckSince` duration |
| Circuit breaker OPEN | -25 | `circuitState === 'OPEN'` |
| Recovery attempts >5 | -20 | `recoveryAttempts` count |

### Dashboard Components
1. **System Health Card**: CPU, Memory, Uptime
2. **Instances Health Table**: Per-instance status with health scores
3. **Watchdog Metrics Card**: Recovery statistics, success rate
4. **Recent Events Timeline**: Health events log

### Watchdog Metrics
| Metric | Description |
|--------|-------------|
| `status` | running/stopped/unknown |
| `uptime` | Seconds since process start |
| `recoveriesTotal` | All-time recovery count |
| `recoveriesToday` | Last 24 hours recoveries |
| `successRate` | Successful recoveries percentage |

---

## Environment Configuration

Key environment variables are defined in `.env.example`. The system uses a strongly-typed configuration system via `src/config/env.config.ts`.

Critical configurations:
- `DATABASE_PROVIDER`: postgresql or mysql
- `DATABASE_CONNECTION_URI`: Database connection string
- `AUTHENTICATION_API_KEY`: Global API authentication
- `REDIS_ENABLED`: Enable Redis cache
- `RABBITMQ_ENABLED`/`SQS_ENABLED`: Message queue options

## Development Guidelines

The project follows comprehensive development standards defined in `.cursor/rules/`:

### Core Principles
- **Always respond in Portuguese (PT-BR)** for user communication
- **Follow established architecture patterns** (Service Layer, RouterBroker, etc.)
- **Robust error handling** with retry logic and graceful degradation
- **Multi-database compatibility** (PostgreSQL and MySQL)
- **Security-first approach** with input validation and rate limiting
- **Performance optimizations** with Redis caching and connection pooling

### Code Standards
- **TypeScript strict mode** with full type coverage
- **JSONSchema7** for input validation (not class-validator)
- **Conventional Commits** enforced by commitlint
- **ESLint + Prettier** for code formatting
- **Service Object pattern** for business logic
- **RouterBroker pattern** for route handling with `dataValidate`

### Architecture Patterns
- **Multi-tenant isolation** at database and instance level
- **Event-driven communication** with EventEmitter2
- **Microservices integration** pattern for external services
- **Connection pooling** and lifecycle management
- **Caching strategy** with Redis primary and Node-cache fallback

## Testing Approach

Currently, the project has minimal formal testing infrastructure:
- **Manual testing** is the primary approach
- **Integration testing** in development environment
- **No unit test suite** currently implemented
- Test files can be placed in `test/` directory as `*.test.ts`
- Run `npm test` for watch mode development testing

### Recommended Testing Strategy
- Focus on **critical business logic** in services
- **Mock external dependencies** (WhatsApp APIs, databases)
- **Integration tests** for API endpoints
- **Manual testing** for WhatsApp connection flows

## Standard Workflow After Code Changes

**IMPORTANTE:** Dopo ogni modifica al codice backend, seguire SEMPRE questa sequenza:

### 1. Build del Backend
```bash
npm run build
```
- Compila TypeScript → JavaScript
- Verifica errori di compilazione
- Output in `dist/` directory
- **OBBLIGATORIO** prima del restart

### 2. Riavvio Server PM2
```bash
pm2 restart evolution-api
```
- Riavvia il processo Evolution API
- Carica il codice compilato aggiornato
- Mantiene il processo in background
- **Necessario** per applicare le modifiche

### 3. Push su GitHub (Solo Modifiche)
```bash
git add <file-modificati>
git commit -m "descrizione modifiche"
git push origin main
```
- **NON fare** `git add .` (troppo generico)
- Aggiungere SOLO file effettivamente modificati
- Commit message descrittivo
- Push su branch `main`

**Sequenza completa esempio:**
```bash
# 1. Build
cd /root/evolution-api
npm run build

# 2. Restart
pm2 restart evolution-api

# 3. Verifica
pm2 logs evolution-api --lines 20

# 4. Push
git add src/api/controllers/example.controller.ts
git commit -m "feat: add new feature to example controller"
git push origin main
```

### Frontend (se modificato)
Se hai modificato file in `evolution-manager-v2/`:
```bash
# 1. Build frontend
cd evolution-manager-v2
npm run build

# 2. Deploy in manager/dist
cd ..
rm -rf manager/dist
cp -r evolution-manager-v2/dist manager/dist

# 3. Restart backend (serve i file statici)
pm2 restart evolution-api

# 4. Push (include submodule + dist)
git add evolution-manager-v2 manager/dist
git commit -m "feat: frontend changes"
git push origin main
```

---

## Git Workflow (Fork Repository)

### CRITICAL: This is a Fork
| Property | Value |
|----------|-------|
| **Origin** | `github.com/Leader24-TOP-AI/evolution-api` |
| **Type** | Fork (not original repository) |
| **Branch** | `main` |

**DO NOT**:
- Push multiple times without verifying previous push succeeded
- Use `git add .` (too broad)
- Force push (`--force`)
- Amend commits that were already pushed

### Git Submodule: evolution-manager-v2
The frontend is a **git submodule** - a separate repository inside this one.

**Submodule Location**: `evolution-manager-v2/`

**Correct Workflow for Submodule Changes**:
```bash
# 1. Make changes in submodule
cd evolution-manager-v2
# ... edit files ...

# 2. Commit in submodule FIRST
git add <modified-files>
git commit -m "feat: submodule changes"
git push origin main

# 3. Go back to parent
cd ..

# 4. Build and copy to manager/dist
npm run build --prefix evolution-manager-v2
rm -rf manager/dist
cp -r evolution-manager-v2/dist manager/dist

# 5. Update parent reference to new submodule commit
git add evolution-manager-v2 manager/dist
git commit -m "feat: update frontend submodule"
git push origin main
```

### Pre-commit Hooks (Husky)
**Configuration**: `.husky/` directory

| Hook | Action |
|------|--------|
| `pre-commit` | ESLint auto-fix on staged files |
| `commit-msg` | Commitlint validates message format |

### Commit Message Format (Conventional Commits)
```
type(scope): subject

body (optional)

footer (optional)
```

**Types**:
| Type | Usage |
|------|-------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, semicolons) |
| `refactor` | Code change that neither fixes bug nor adds feature |
| `perf` | Performance improvement |
| `test` | Adding tests |
| `chore` | Maintenance tasks |
| `ci` | CI/CD changes |
| `build` | Build system changes |

**Rules**:
- Subject: **lowercase**, no period at end, max 100 chars
- Scope: optional, lowercase
- Body: wrap at 100 chars

**Examples**:
```bash
# Good
git commit -m "feat(auth): add jwt token refresh"
git commit -m "fix: resolve memory leak in websocket handler"
git commit -m "docs: update claude.md with defense in depth"

# Bad - will be rejected by commitlint
git commit -m "Added new feature"  # Wrong: past tense, no type
git commit -m "feat: Add Feature." # Wrong: capital letter, period
```

### Log Rotation
**Configuration**: `/etc/logrotate.d/pm2-evolution-api`

PM2 logs are rotated daily with 90-day retention:
- `evolution-api-*.log`
- `evolution-watchdog-*.log`

---

## Deployment Considerations

- Docker support with `Dockerfile` and `docker-compose.yaml`
- Graceful shutdown handling for connections
- Health check endpoints for monitoring
- Sentry integration for error tracking
- Telemetry for usage analytics (non-sensitive data only)

---

## Known Issues and Troubleshooting

### WhatsApp Instance Connection Stability

**Issue**: After extended periods of connection (several hours), WhatsApp instances may experience disconnections with statusCode 408 (timeout) or 428 (connection closed), typically related to proxy IP changes or network instability.

**Defense in Depth Protection** (see "Defense in Depth Architecture" section):
The system has a 3-layer protection mechanism:

| Layer | Component | Detection Time | Action |
|-------|-----------|----------------|--------|
| 1 | Timeout Protection | Immediate | Prevents hanging operations |
| 2 | Circuit Breaker | After 5 failures | Isolates failing instance |
| 3 | External Watchdog | 90-120 seconds | Escalating recovery |

**Expected Recovery Time**:
| Scenario | Recovery Time | Mechanism |
|----------|---------------|-----------|
| Normal disconnection | 2-5 seconds | Internal reconnection |
| Stuck in connecting | 90-120 seconds | Watchdog detection |
| Circuit breaker OPEN | 60 seconds | Automatic half-open test |
| Complete freeze | 60-180 seconds | Watchdog PM2 restart |

**If Manual Intervention Needed**:
- Dashboard restart button available per instance
- API endpoint: `POST /instance/restart/:instanceName`
- Reset circuit breaker: `POST /health-monitor/circuit-breaker/reset/:name`
- Health dashboard: `/health-monitor` in manager UI

**Monitoring Commands**:
```bash
# Watch both processes
pm2 list

# API logs with health info
pm2 logs evolution-api | grep -E "Auto-Restart|HealthCheck|CONNECTED|Circuit"

# Watchdog logs (separate process)
pm2 logs evolution-watchdog

# Enable watchdog debug mode
WATCHDOG_DEBUG=true pm2 restart evolution-watchdog

# Check health dashboard API
curl http://localhost:8080/health-monitor/dashboard -H "apikey: YOUR_KEY"
```

**Troubleshooting Escalation**:
1. Check Health Dashboard (`/health-monitor`) for health scores
2. Check Watchdog status: `pm2 show evolution-watchdog`
3. View recent health events in dashboard
4. If circuit breaker stuck OPEN, reset via API
5. If watchdog not recovering, check DB connectivity

**Related Files**:
- Connection management: `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`
- Health Monitor: `src/api/services/health-monitor.service.ts`
- Circuit Breaker: `src/utils/circuit-breaker.ts`
- Watchdog Service: `src/watchdog/watchdog.service.ts`
- Resource Registry: `src/utils/resource-registry.ts`
- Async Timeout: `src/utils/async-timeout.ts`

### Database Connection Issues

**Symptoms**: Slow queries, timeouts, connection pool exhaustion

**Protection**: Layer 1 Timeout Protection wraps all DB queries with 5000ms timeout

**Monitoring**:
```bash
# Check circuit breaker state
curl http://localhost:8080/health-monitor/dashboard -H "apikey: YOUR_KEY" | jq '.instances[].circuitState'
```

### Memory Leaks

**Symptoms**: Gradual memory increase, eventual crash

**Protection**: Resource Registry tracks all timers, listeners, and child processes

**Monitoring**:
```bash
# Check memory usage
pm2 show evolution-api | grep memory

# View resource stats via Health Monitor API
curl http://localhost:8080/health-monitor/system -H "apikey: YOUR_KEY"
```