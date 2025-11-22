# CLAUDE.md

This file provides comprehensive guidance to Claude AI when working with the Evolution API codebase.

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

### Multi-tenancy Support
- Instance isolation at database level
- Separate webhook configurations per instance
- Independent integration settings per instance

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

## Deployment Considerations

- Docker support with `Dockerfile` and `docker-compose.yaml`
- Graceful shutdown handling for connections
- Health check endpoints for monitoring
- Sentry integration for error tracking
- Telemetry for usage analytics (non-sensitive data only)

---

## Critical Bug Fixes and Resolutions

### ✅ FIX: WhatsApp Instance Stuck in "connecting" State (Nov 2025)

**Problem**: WhatsApp instances would get stuck in "connecting" state after disconnection (statusCode 408/428) and never recover automatically, requiring manual restart from dashboard.

**Root Cause**: Deadlock in auto-restart system where `isAutoRestarting` flag blocked timer activation:
1. Auto-restart sets `isAutoRestarting = true`
2. Creates new client → enters "connecting" state
3. Timer checks `!isAutoRestarting` before starting → FALSE
4. Timer never starts → Instance stuck forever
5. Manual restart worked because it didn't set the flag

**Solution Implemented** (File: `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`):

1. **New `cleanupClient()` function** (lines 856-913):
   - Complete cleanup of WebSocket, Baileys client, and timers
   - Consistent cleanup across all restart paths
   - Prevents memory leaks and resource conflicts

2. **New `isRestartInProgress` flag** (line 265):
   - Separate lock for preventing duplicate restart calls
   - Doesn't block timer activation (solves deadlock)
   - More granular control than `isAutoRestarting`

3. **`autoRestart()` rewritten** (lines 728-892):
   - Resets `isAutoRestarting = false` BEFORE creating new client (line 810)
   - Direct call to `createClient()` instead of controller (line 816)
   - Improved safety timeout: triggers force close instead of just resetting flag
   - Preserves `wasOpenBeforeReconnect` across timeouts
   - Detailed logging with emojis and timestamps

4. **`forceRestart()` rewritten** (lines 1205-1373):
   - Same deadlock fix applied
   - Consistent with `autoRestart()` behavior
   - Uses `cleanupClient()` for cleanup

5. **Health check optimized** (line 272):
   - `stuckInConnectingThreshold` reduced from 30s to 10s
   - 3x faster detection of stuck instances
   - More reactive backup system

6. **`connectionUpdate()` updated**:
   - Uses `isRestartInProgress` in timer condition (line 680)
   - Timer can now start during auto-restart
   - Detailed logging with all flags for debugging

**Expected Behavior After Fix**:
- Auto-recovery within 5-15 seconds from disconnection
- No more infinite stuck states
- Triple safety net:
  1. Auto-restart timer (5s)
  2. Health check backup (10s)
  3. Safety timeout force close (30s)

**Monitoring**: Watch for these log patterns to verify fix is working:
```
[Auto-Restart] Instance xxx - 🔓 Resetting isAutoRestarting flag  ← Fix applied
[Auto-Restart] Instance xxx - 🔌 Creating new client               ← Direct call
[Auto-Restart] Instance xxx - SUCCESS! Connection restored         ← Auto-recovery
```

**Files Modified**:
- `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`

**Date**: November 22, 2025