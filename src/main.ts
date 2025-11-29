// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Now import other modules
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, healthMonitorService, proxyMonitorService, waMonitor } from '@api/server.module';
import {
  Auth,
  configService,
  Cors,
  HttpServer,
  ProviderSession,
  Sentry as SentryConfig,
  Webhook,
} from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { ServerUP } from '@utils/server-up';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

function initWA() {
  waMonitor.loadInstance();
  proxyMonitorService.startMonitoring();
  healthMonitorService.startCleanupScheduler();
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) {
          return callback(null, true);
        }
        if (ORIGIN.indexOf(requestOrigin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));

  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  app.use('/', router);

  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const webhook = configService.get<Webhook>('WEBHOOK');

        if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS_WEBHOOK != '' && webhook.EVENTS.ERRORS) {
          const tzoffset = new Date().getTimezoneOffset() * 60000; //offset in milliseconds
          const localISOTime = new Date(Date.now() - tzoffset).toISOString();
          const now = localISOTime;
          const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
          const serverUrl = configService.get<HttpServer>('SERVER').URL;

          const errorData = {
            event: 'error',
            data: {
              error: err['error'] || 'Internal Server Error',
              message: err['message'] || 'Internal Server Error',
              status: err['status'] || 500,
              response: {
                message: err['message'] || 'Internal Server Error',
              },
            },
            date_time: now,
            api_key: globalApiKey,
            server_url: serverUrl,
          };

          logger.error(errorData);

          const baseURL = webhook.EVENTS.ERRORS_WEBHOOK;
          const httpService = axios.create({ baseURL });

          httpService.post('', errorData);
        }

        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: {
            message: err['message'] || 'Internal Server Error',
          },
        });
      }

      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });

      next();
    },
  );

  const httpServer = configService.get<HttpServer>('SERVER');

  ServerUP.app = app;
  let server = ServerUP[httpServer.TYPE];

  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");

    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  eventManager.init(server);

  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');

    // Add this after all routes,
    // but before any and other error-handling middlewares are defined
    Sentry.setupExpressErrorHandler(app);
  }

  server.listen(httpServer.PORT, () => logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT));

  initWA();

  onUnexpectedError();

  // ✅ FIX 8: Graceful shutdown handler per SIGTERM/SIGINT
  const gracefulShutdown = async (signal: string) => {
    logger.info(`${signal} received, initiating graceful shutdown...`);

    // Stop accettare nuove richieste
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Chiudere istanze WhatsApp con timeout
    const shutdownTimeout = 30000; // 30 secondi max per shutdown globale
    const instanceTimeout = 10000; // ✅ FIX: Aumentato da 5s a 10s per istanza

    try {
      const instanceNames = Object.keys(waMonitor.waInstances);
      logger.info(`Closing ${instanceNames.length} WhatsApp instance(s) in parallel...`);

      // ✅ FIX: Chiusura PARALLELA invece di sequenziale
      // Con 20 istanze sequenziali a 5s = 100s, ma timeout globale era 30s
      // Con parallelo, tutte le istanze vengono chiuse contemporaneamente
      const closeResults = await Promise.race([
        Promise.allSettled(
          instanceNames.map(async (name) => {
            try {
              const instance = waMonitor.waInstances[name];

              // ✅ FIX: Skip istanze ancora in fase di creazione (non hanno client completo)
              if (instance?.lastConnectionState === 'connecting') {
                logger.info(`Instance ${name} still connecting, skipping graceful close`);
                return { name, status: 'skipped', reason: 'connecting' };
              }

              // Cleanup ResourceRegistry PRIMA di chiudere il client
              if (instance?.resourceRegistry) {
                const cleanupResult = instance.resourceRegistry.cleanupAll('graceful_shutdown');
                logger.info(
                  `Instance ${name} resources cleaned: ${cleanupResult.total} ` +
                    `(${cleanupResult.timers} timers, ${cleanupResult.listeners} listeners, ${cleanupResult.processes} processes)`,
                );
              }

              // Timeout individuale su client.end() per evitare blocchi
              if (instance?.client) {
                await Promise.race([
                  instance.client.end('shutdown'),
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('client.end timeout')), instanceTimeout),
                  ),
                ]);
              }
              logger.info(`Instance ${name} closed`);
              return { name, status: 'closed' };
            } catch (e: any) {
              logger.warn(`Instance ${name} close error: ${e.message}`);
              return { name, status: 'error', error: e.message };
            }
          }),
        ),
        // Timeout globale come safety net
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('global shutdown timeout')), shutdownTimeout),
        ),
      ]);

      // Log risultati
      const closed = closeResults.filter((r) => r.status === 'fulfilled' && r.value?.status === 'closed').length;
      const skipped = closeResults.filter((r) => r.status === 'fulfilled' && r.value?.status === 'skipped').length;
      const errors = closeResults.filter((r) => r.status === 'rejected' || r.value?.status === 'error').length;
      logger.info(`Shutdown results: ${closed} closed, ${skipped} skipped, ${errors} errors`);

      // Disconnettere DB con timeout
      const dbDisconnectTimeout = 10000; // 10 secondi max per DB disconnect
      try {
        await Promise.race([
          prismaRepository.$disconnect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('DB disconnect timeout')), dbDisconnectTimeout)),
        ]);
        logger.info('Database disconnected');
      } catch (dbError: any) {
        logger.warn(`Database disconnect timeout/error: ${dbError.message}, continuing shutdown`);
      }
    } catch (e: any) {
      logger.error(`Error during graceful shutdown: ${e.message}`);
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap();
