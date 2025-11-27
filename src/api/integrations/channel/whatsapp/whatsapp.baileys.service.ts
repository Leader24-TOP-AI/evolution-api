import { getCollectionsDto } from '@api/dto/business.dto';
import { OfferCallDto } from '@api/dto/call.dto';
import {
  ArchiveChatDto,
  BlockUserDto,
  DeleteMessage,
  getBase64FromMediaMessageDto,
  LastMessage,
  MarkChatUnreadDto,
  NumberBusiness,
  OnWhatsAppDto,
  PrivacySettingDto,
  ReadMessageDto,
  SendPresenceDto,
  UpdateMessageDto,
  WhatsAppNumberDto,
} from '@api/dto/chat.dto';
import {
  AcceptGroupInvite,
  CreateGroupDto,
  GetParticipant,
  GroupDescriptionDto,
  GroupInvite,
  GroupJid,
  GroupPictureDto,
  GroupSendInvite,
  GroupSubjectDto,
  GroupToggleEphemeralDto,
  GroupUpdateParticipantDto,
  GroupUpdateSettingDto,
} from '@api/dto/group.dto';
import { InstanceDto, SetPresenceDto } from '@api/dto/instance.dto';
import { HandleLabelDto, LabelDto } from '@api/dto/label.dto';
import {
  Button,
  ContactMessage,
  KeyType,
  MediaMessage,
  Options,
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendPtvDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTextDto,
  StatusMessage,
  TypeButton,
} from '@api/dto/sendMessage.dto';
import { chatwootImport } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper';
import * as s3Service from '@api/integrations/storage/s3/libs/minio.server';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository, Query } from '@api/repository/repository.service';
import { chatbotController, waMonitor } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { ChannelStartupService } from '@api/services/channel.service';
import { Events, MessageSubtype, TypeMediaMessage, wa } from '@api/types/wa.types';
import { CacheEngine } from '@cache/cacheengine';
import {
  AudioConverter,
  CacheConf,
  Chatwoot,
  ConfigService,
  configService,
  ConfigSessionPhone,
  Database,
  Log,
  Openai,
  ProviderSession,
  QrCode,
  S3,
} from '@config/env.config';
import { BadRequestException, InternalServerErrorException, NotFoundException } from '@exceptions';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { Boom } from '@hapi/boom';
import { createId as cuid } from '@paralleldrive/cuid2';
import { Instance, Message } from '@prisma/client';
// ✅ DEFENSE IN DEPTH: Import nuove utility per protezione 100%
import { TimeoutError, withDbTimeout, withHttpTimeout, withRedisTimeout } from '@utils/async-timeout';
import { CircuitBreaker } from '@utils/circuit-breaker';
import { createJid } from '@utils/createJid';
import { fetchLatestWaWebVersion } from '@utils/fetchLatestWaWebVersion';
import { makeProxyAgent, makeProxyAgentUndici } from '@utils/makeProxyAgent';
import { getOnWhatsappCache, saveOnWhatsappCache } from '@utils/onWhatsappCache';
import { status } from '@utils/renderStatus';
import { ResourceRegistry } from '@utils/resource-registry';
import { sendTelemetry } from '@utils/sendTelemetry';
import useMultiFileAuthStatePrisma from '@utils/use-multi-file-auth-state-prisma';
import { AuthStateProvider } from '@utils/use-multi-file-auth-state-provider-files';
import { useMultiFileAuthStateRedisDb } from '@utils/use-multi-file-auth-state-redis-db';
import axios from 'axios';
import makeWASocket, {
  AnyMessageContent,
  BufferedEventData,
  BufferJSON,
  CacheStore,
  CatalogCollection,
  Chat,
  ConnectionState,
  Contact,
  delay,
  DisconnectReason,
  downloadContentFromMessage,
  downloadMediaMessage,
  generateWAMessageFromContent,
  getAggregateVotesInPollMessage,
  GetCatalogOptions,
  getContentType,
  getDevice,
  GroupMetadata,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isPnUser,
  makeCacheableSignalKeyStore,
  MessageUpsertType,
  MessageUserReceiptUpdate,
  MiscMessageGenerationOptions,
  ParticipantAction,
  prepareWAMessageMedia,
  Product,
  proto,
  UserFacingSocketConfig,
  WABrowserDescription,
  WAMediaUpload,
  WAMessage,
  WAMessageKey,
  WAPresence,
  WASocket,
} from 'baileys';
import { Label } from 'baileys/lib/Types/Label';
import { LabelAssociation } from 'baileys/lib/Types/LabelAssociation';
import { spawn } from 'child_process';
import { isArray, isBase64, isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
import ffmpeg from 'fluent-ffmpeg';
import FormData from 'form-data';
import Long from 'long';
import mimeTypes from 'mime-types';
import NodeCache from 'node-cache';
import cron from 'node-cron';
import { release } from 'os';
import { join } from 'path';
import P from 'pino';
import qrcode, { QRCodeToDataURLOptions } from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import sharp from 'sharp';
import { PassThrough, Readable } from 'stream';
import { v4 } from 'uuid';

import { BaileysMessageProcessor } from './baileysMessage.processor';
import { useVoiceCallsBaileys } from './voiceCalls/useVoiceCallsBaileys';

export interface ExtendedIMessageKey extends proto.IMessageKey {
  remoteJidAlt?: string;
  participantAlt?: string;
  server_id?: string;
  isViewOnce?: boolean;
}

const groupMetadataCache = new CacheService(new CacheEngine(configService, 'groups').getEngine());

// Adicione a função getVideoDuration no início do arquivo
async function getVideoDuration(input: Buffer | string | Readable): Promise<number> {
  const MediaInfoFactory = (await import('mediainfo.js')).default;
  const mediainfo = await MediaInfoFactory({ format: 'JSON' });

  let fileSize: number;
  let readChunk: (size: number, offset: number) => Promise<Buffer>;

  if (Buffer.isBuffer(input)) {
    fileSize = input.length;
    readChunk = async (size: number, offset: number): Promise<Buffer> => {
      return input.slice(offset, offset + size);
    };
  } else if (typeof input === 'string') {
    const fs = await import('fs');
    const stat = await fs.promises.stat(input);
    fileSize = stat.size;
    const fd = await fs.promises.open(input, 'r');

    readChunk = async (size: number, offset: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(size);
      await fd.read(buffer, 0, size, offset);
      return buffer;
    };

    try {
      const result = await mediainfo.analyzeData(() => fileSize, readChunk);
      const jsonResult = JSON.parse(result);

      const generalTrack = jsonResult.media.track.find((t: any) => t['@type'] === 'General');
      const duration = generalTrack.Duration;

      return Math.round(parseFloat(duration));
    } finally {
      await fd.close();
    }
  } else if (input instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    fileSize = data.length;

    readChunk = async (size: number, offset: number): Promise<Buffer> => {
      return data.slice(offset, offset + size);
    };
  } else {
    throw new Error('Tipo de entrada não suportado');
  }

  const result = await mediainfo.analyzeData(() => fileSize, readChunk);
  const jsonResult = JSON.parse(result);

  const generalTrack = jsonResult.media.track.find((t: any) => t['@type'] === 'General');
  const duration = generalTrack.Duration;

  return Math.round(parseFloat(duration));
}

export class BaileysStartupService extends ChannelStartupService {
  private messageProcessor = new BaileysMessageProcessor();

  constructor(
    public readonly configService: ConfigService,
    public readonly eventEmitter: EventEmitter2,
    public readonly prismaRepository: PrismaRepository,
    public readonly cache: CacheService,
    public readonly chatwootCache: CacheService,
    public readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {
    super(configService, eventEmitter, prismaRepository, chatwootCache);
    this.instance.qrcode = { count: 0 };
    this.messageProcessor.mount({
      onMessageReceive: this.messageHandle['messages.upsert'].bind(this), // Bind the method to the current context
    });

    this.authStateProvider = new AuthStateProvider(this.providerFiles);

    // ✅ DEFENSE IN DEPTH: Inizializza Layer 1 (Resource Registry) e Layer 2 (Circuit Breaker)
    // Il nome istanza viene settato dopo, quindi usiamo un placeholder temporaneo
    this.resourceRegistry = new ResourceRegistry('pending-init');

    // Circuit Breaker con configurazione ottimizzata per WhatsApp
    this.circuitBreaker = new CircuitBreaker({
      name: 'pending-init',
      failureThreshold: 5, // 5 fallimenti prima di aprire
      successThreshold: 2, // 2 successi per chiudere
      resetTimeout: 60000, // 60s in OPEN prima di HALF_OPEN
      halfOpenMaxAttempts: 3, // 3 tentativi in HALF_OPEN
      failureWindowMs: 60000, // Finestra 60s per contare fallimenti
    });

    // ✅ FIX: Salva unsubscribe per evitare memory leak (callback accumulation)
    const unsubscribeOpen = this.circuitBreaker.onCircuitOpen((name, reason) => {
      this.logger.error(`[CircuitBreaker] Instance ${name} - CIRCUIT OPENED: ${reason}`);
      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: name,
        event: 'circuit_breaker_open',
        reason: reason,
        state: this.stateConnection.state,
        timestamp: new Date().toISOString(),
      });
    });

    // ✅ BUG FIX 2: Auto-recovery quando circuit entra in HALF_OPEN
    // Questo risolve il problema dove l'istanza rimaneva bloccata per sempre dopo circuit OPEN
    const unsubscribeHalfOpen = this.circuitBreaker.onCircuitHalfOpen((name) => {
      this.logger.info(`[CircuitBreaker] Instance ${name} - CIRCUIT HALF_OPEN: Attempting auto-recovery...`);
      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: name,
        event: 'circuit_breaker_half_open',
        state: this.stateConnection.state,
        timestamp: new Date().toISOString(),
      });

      // Trigger auto-recovery SOLO se non è già in corso un restart
      if (!this.isRestartInProgress && !this.isAutoRestarting) {
        this.logger.info(`[CircuitBreaker] Instance ${name} - Triggering reconnection attempt from HALF_OPEN`);
        // Reset retry counter per permettere nuovi tentativi
        this.autoRestartAttempts = 0;
        // Trigger reconnection
        this.connectToWhatsapp().catch((err) => {
          this.logger.error(`[CircuitBreaker] Instance ${name} - Auto-recovery failed: ${err.message}`);
          this.circuitBreaker.recordFailure(`auto_recovery_failed: ${err.message}`);
        });
      } else {
        this.logger.warn(`[CircuitBreaker] Instance ${name} - Skipping auto-recovery (restart already in progress)`);
      }
    });

    // Store combined unsubscribe function
    this.circuitBreakerUnsubscribe = () => {
      unsubscribeOpen();
      unsubscribeHalfOpen();
    };
  }

  /**
   * Override setInstance to update Circuit Breaker and ResourceRegistry names
   * ✅ BUG FIX 1: Il circuit breaker era creato con nome 'pending-init' invece del nome istanza
   * Questo causava confusione nei log e recovery non funzionante per istanza specifica
   */
  public setInstance(instance: import('@api/dto/instance.dto').InstanceDto): void {
    // Call parent method first to set this.instance.name
    super.setInstance(instance);

    // Now update Circuit Breaker and ResourceRegistry with the actual instance name
    if (this.circuitBreaker && instance.instanceName) {
      this.circuitBreaker.updateName(instance.instanceName);
      this.logger.info(`[SetInstance] Circuit Breaker name updated to: ${instance.instanceName}`);
    }

    if (this.resourceRegistry && instance.instanceName) {
      this.resourceRegistry.updateName(instance.instanceName);
      this.logger.info(`[SetInstance] ResourceRegistry name updated to: ${instance.instanceName}`);
    }
  }

  private authStateProvider: AuthStateProvider;
  private readonly msgRetryCounterCache: CacheStore = new NodeCache();
  private readonly userDevicesCache: CacheStore = new NodeCache({ stdTTL: 300000, useClones: false });
  private endSession = false;
  private logBaileys = this.configService.get<Log>('LOG').BAILEYS;

  // Cache TTL constants (in seconds)
  private readonly MESSAGE_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes - avoid duplicate message processing
  private readonly UPDATE_CACHE_TTL_SECONDS = 30 * 60; // 30 minutes - avoid duplicate status updates

  public stateConnection: wa.StateConnection = { state: 'close' };

  // Auto-restart on proxy IP change
  private connectingTimer: NodeJS.Timeout | null = null;
  private autoRestartAttempts: number = 0;
  private lastConnectionState: string = 'close';
  private isAutoRestarting: boolean = false;
  private wasOpenBeforeReconnect: boolean = false;
  private isAutoRestartTriggered: boolean = false;
  // ✅ FIX DEFINITIVO: Nuovo flag per prevenire race conditions senza bloccare timer
  private isRestartInProgress: boolean = false;

  // ✅ FASE 2: Health Check System
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private lastStateChangeTimestamp: number = Date.now();
  private healthCheckInterval = 60000; // 60 secondi
  // ✅ FIX DEFINITIVO: Ridotto da 30s a 10s per detection più veloce delle istanze stuck
  private stuckInConnectingThreshold = 10000; // 10 secondi (era 30s)

  // ✅ FASE 3: Auto-restart optimization
  private readonly autoRestartTimerMs = 5000; // 5 secondi (ridotto da 15s per recovery più veloce)
  private readonly maxAutoRestartAttempts = 10; // Aumentato da 5 a 10

  // ✅ FIX #1: Safety timeout management (prevent memory leak)
  private safetyTimeout: NodeJS.Timeout | null = null;

  // ✅ FIX #2: Force restart attempts tracking
  private forceRestartAttempts = 0;
  private readonly MAX_FORCE_RESTART_ATTEMPTS = 5;
  private lastForceRestartTime = 0;
  private readonly MIN_FORCE_RESTART_INTERVAL = 5000; // 5s minimo tra force restart

  // ✅ FIX #8: Cache per ottimizzazioni
  private cachedOwnerJid: string | null = null;
  private proxyTestCache: Map<string, { result: boolean; timestamp: number }> = new Map();
  private readonly PROXY_TEST_CACHE_TTL = 120000; // 2 minuti

  // ✅ FIX #11: Log state tracking
  private lastLoggedHealthState: { state: string; age: number } | null = null;

  // ✅ DEFENSE IN DEPTH - Layer 1: Resource Registry per tracking e cleanup
  private resourceRegistry: ResourceRegistry;

  // ✅ DEFENSE IN DEPTH - Layer 2: Circuit Breaker per fail-fast
  private circuitBreaker: CircuitBreaker;

  // ✅ FIX: Funzione per unsubscribe dal circuit breaker (evita memory leak)
  private circuitBreakerUnsubscribe: (() => void) | null = null;

  // ✅ DEFENSE IN DEPTH - Hard limits per prevenire loop infiniti
  private readonly HARD_MAX_RESTART_ATTEMPTS = 20; // Limite assoluto restart
  private readonly HARD_MAX_RECURSION_DEPTH = 3; // Limite recursione safety timeout
  private safetyTimeoutRecursionDepth = 0; // Contatore recursione corrente
  private globalRestartCounter = 0; // Contatore restart in finestra temporale
  private globalRestartResetTimer: NodeJS.Timeout | null = null;
  private readonly GLOBAL_RESTART_WINDOW = 300000; // 5 minuti
  private readonly GLOBAL_RESTART_MAX = 30; // Max 30 restart in 5 minuti

  // ✅ DEFENSE IN DEPTH - Layer 3: Heartbeat per watchdog esterno
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 secondi

  // ✅ EXPONENTIAL BACKOFF - Sostituisce limiti rigidi per evitare blocco permanente
  private currentRestartDelay = 5000; // Delay attuale (inizia 5s)
  private readonly MIN_RESTART_DELAY = 5000; // Minimo 5s
  private readonly MAX_RESTART_DELAY = 30000; // Massimo 30 secondi (ragionevole per UX cliente)
  private lastSuccessfulConnection = 0; // Timestamp ultima connessione OK
  private readonly STABLE_CONNECTION_TIME = 120000; // 2 min per considerare stabile e reset delay

  public phoneNumber: string;

  public get connectionStatus() {
    return this.stateConnection;
  }

  public async logoutInstance() {
    this.logger.info(`[Logout] Instance ${this.instance.name} - Starting logout process...`);

    this.messageProcessor.onDestroy();

    // ✅ FIX 1.5: Unsubscribe dal circuit breaker per evitare memory leak
    if (this.circuitBreakerUnsubscribe) {
      this.logger.verbose(`[Logout] Instance ${this.instance.name} - Unsubscribing from circuit breaker`);
      this.circuitBreakerUnsubscribe();
      this.circuitBreakerUnsubscribe = null;
    }

    // ✅ FIX 1.1: Usa ResourceRegistry per cleanup completo di tutte le risorse
    this.logger.info(`[Logout] Instance ${this.instance.name} - 🧹 Cleaning up all registered resources...`);
    const cleanupResult = this.resourceRegistry.cleanupAll('logout');
    this.logger.info(
      `[Logout] Instance ${this.instance.name} - ResourceRegistry cleanup: ${cleanupResult.total} resources ` +
        `(${cleanupResult.timers} timers, ${cleanupResult.listeners} listeners, ${cleanupResult.processes} processes)`,
    );

    // ✅ FIX DEFINITIVO: Usa cleanupClient() per cleanup completo e consistente
    this.logger.info(`[Logout] Instance ${this.instance.name} - 🧹 Performing complete client cleanup...`);
    this.cleanupClient('logout');

    // Ferma health check e heartbeat
    this.stopHealthCheck();
    this.stopHeartbeat();

    // Reset tutti i flag
    this.isAutoRestarting = false;
    this.isAutoRestartTriggered = false;
    this.isRestartInProgress = false;
    this.wasOpenBeforeReconnect = false;
    this.autoRestartAttempts = 0;
    this.forceRestartAttempts = 0;

    await this.client?.logout('Log out instance: ' + this.instanceName);

    // ✅ FIX #6: Reset ownerJid al logout per permettere riuso nome istanza
    // ✅ FIX 2.5: Aggiungo timeout per evitare blocco durante logout
    await withDbTimeout(
      this.prismaRepository.instance.update({
        where: { id: this.instanceId },
        data: {
          ownerJid: null,
          profileName: null,
          profilePicUrl: null,
          connectionStatus: 'close',
        },
      }),
      'logout:instanceUpdate',
    );

    // ✅ FIX 2.5: Aggiungo timeout per evitare blocco durante logout
    const sessionExists = await withDbTimeout(
      this.prismaRepository.session.findFirst({ where: { sessionId: this.instanceId } }),
      'logout:sessionFind',
    );
    if (sessionExists) {
      await withDbTimeout(
        this.prismaRepository.session.delete({ where: { sessionId: this.instanceId } }),
        'logout:sessionDelete',
      );
    }
  }

  public async getProfileName() {
    let profileName = this.client.user?.name ?? this.client.user?.verifiedName;
    if (!profileName) {
      // ✅ FIX 4: Timeout su query DB per evitare blocco indefinito
      const data = await withDbTimeout(
        this.prismaRepository.session.findUnique({ where: { sessionId: this.instanceId } }),
        'getProfileName:sessionFind',
      );

      if (data) {
        const creds = JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver);
        profileName = creds.me?.name || creds.me?.verifiedName;
      }
    }

    return profileName;
  }

  public async getProfileStatus() {
    const status = await this.client.fetchStatus(this.instance.wuid);

    return status[0]?.status;
  }

  public get profilePictureUrl() {
    return this.instance.profilePictureUrl;
  }

  public get qrCode(): wa.QrCode {
    return {
      pairingCode: this.instance.qrcode?.pairingCode,
      code: this.instance.qrcode?.code,
      base64: this.instance.qrcode?.base64,
      count: this.instance.qrcode?.count,
    };
  }

  private async connectionUpdate({ qr, connection, lastDisconnect }: Partial<ConnectionState>) {
    if (qr) {
      if (this.instance.qrcode.count === this.configService.get<QrCode>('QRCODE').LIMIT) {
        this.sendDataWebhook(Events.QRCODE_UPDATED, {
          message: 'QR code limit reached, please login again',
          statusCode: DisconnectReason.badSession,
        });

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.QRCODE_UPDATED,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            { message: 'QR code limit reached, please login again', statusCode: DisconnectReason.badSession },
          );
        }

        this.sendDataWebhook(Events.CONNECTION_UPDATE, {
          instance: this.instance.name,
          state: 'refused',
          statusReason: DisconnectReason.connectionClosed,
          wuid: this.instance.wuid,
          profileName: await this.getProfileName(),
          profilePictureUrl: this.instance.profilePictureUrl,
        });

        this.endSession = true;

        return this.eventEmitter.emit('no.connection', this.instance.name);
      }

      this.instance.qrcode.count++;

      const color = this.configService.get<QrCode>('QRCODE').COLOR;

      const optsQrcode: QRCodeToDataURLOptions = {
        margin: 3,
        scale: 4,
        errorCorrectionLevel: 'H',
        color: { light: '#ffffff', dark: color },
      };

      if (this.phoneNumber) {
        await delay(1000);
        this.instance.qrcode.pairingCode = await this.client.requestPairingCode(this.phoneNumber);
      } else {
        this.instance.qrcode.pairingCode = null;
      }

      qrcode.toDataURL(qr, optsQrcode, (error, base64) => {
        if (error) {
          this.logger.error('Qrcode generate failed:' + error.toString());
          return;
        }

        this.instance.qrcode.base64 = base64;
        this.instance.qrcode.code = qr;

        this.sendDataWebhook(Events.QRCODE_UPDATED, {
          qrcode: { instance: this.instance.name, pairingCode: this.instance.qrcode.pairingCode, code: qr, base64 },
        });

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.QRCODE_UPDATED,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            {
              qrcode: { instance: this.instance.name, pairingCode: this.instance.qrcode.pairingCode, code: qr, base64 },
            },
          );
        }
      });

      qrcodeTerminal.generate(qr, { small: true }, (qrcode) =>
        this.logger.log(
          `\n{ instance: ${this.instance.name} pairingCode: ${this.instance.qrcode.pairingCode}, qrcodeCount: ${this.instance.qrcode.count} }\n` +
            qrcode,
        ),
      );

      // ✅ FIX 2.5: Timeout su update stato connessione
      await withDbTimeout(
        this.prismaRepository.instance.update({
          where: { id: this.instanceId },
          data: { connectionStatus: 'connecting' },
        }),
        'connectionUpdate:connecting',
      );
    }

    if (connection) {
      this.stateConnection = {
        state: connection,
        statusReason: (lastDisconnect?.error as Boom)?.output?.statusCode ?? 200,
      };
    }

    if (connection === 'close') {
      // ✅ FASE 2: Update timestamp e ferma health check
      this.lastStateChangeTimestamp = Date.now();
      this.stopHealthCheck();

      // Cleanup auto-restart tracking quando la connessione si chiude
      if (this.connectingTimer) {
        clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
      }

      // Salva se l'istanza era 'open' prima del close (per auto-restart dopo riconnessione)
      // Se isAutoRestartTriggered è true, preserva wasOpenBeforeReconnect (evita reset durante auto-restart)
      const wasOpenBeforeClose = this.isAutoRestartTriggered
        ? this.wasOpenBeforeReconnect
        : this.lastConnectionState === 'open';
      this.lastConnectionState = 'close';

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const codesToNotReconnect = [DisconnectReason.loggedOut, DisconnectReason.forbidden, 402, 406];
      const shouldReconnect = !codesToNotReconnect.includes(statusCode);

      if (shouldReconnect) {
        // Se era 'open' e stiamo per riconnettere, potrebbe essere un cambio IP proxy
        this.wasOpenBeforeReconnect = wasOpenBeforeClose;

        // ✅ FIX DEFINITIVO: NON riconnettere se restart è già in corso (evita doppia chiamata)
        // Usa isRestartInProgress invece di isAutoRestarting per maggiore precisione
        if (!this.isRestartInProgress && !this.isAutoRestarting) {
          this.logger.info(
            `[Connection] Instance ${this.instance.name} - 🔄 Reconnecting after close (statusCode: ${statusCode})`,
          );

          // ✅ FASE 1 FIX: Ricarica proxy configuration dal DB PRIMA di riconnettere
          // Questo assicura che se Oxylabs ha cambiato IP o sessione è scaduta, usiamo config fresca
          this.logger.info(
            `[Connection] Instance ${this.instance.name} - Reloading proxy configuration before reconnect...`,
          );
          await this.loadProxy();

          // ✅ FASE 1 FIX: Chiudi completamente il client vecchio prima di riconnettere
          // Il nuovo createClient() creerà un proxy agent completamente nuovo
          if (this.client) {
            this.logger.info(
              `[Connection] Instance ${this.instance.name} - Closing old client completely before reconnect...`,
            );
            this.client?.ws?.close();
            this.client?.end(new Error('Reconnect - closing old client for fresh start'));
            // Piccolo delay per assicurare cleanup completo del socket e proxy agent
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          await this.connectToWhatsapp(this.phoneNumber);
        } else {
          this.logger.info(
            `[Connection] Instance ${this.instance.name} - ⏸️ Skipping auto-reconnect (restart operation in progress: isRestartInProgress=${this.isRestartInProgress}, isAutoRestarting=${this.isAutoRestarting})`,
          );
        }
      } else {
        // Close definitivo (logout, forbidden, etc.) - Reset tutti i flag auto-restart
        this.logger.warn(
          `[Connection] Instance ${this.instance.name} - ❌ Definitive close (statusCode: ${statusCode}) - Resetting all auto-restart flags`,
        );
        this.isAutoRestarting = false;
        this.isAutoRestartTriggered = false;
        this.isRestartInProgress = false; // ← Nuovo flag
        this.wasOpenBeforeReconnect = false;
        this.autoRestartAttempts = 0;
        this.sendDataWebhook(Events.STATUS_INSTANCE, {
          instance: this.instance.name,
          status: 'closed',
          disconnectionAt: new Date(),
          disconnectionReasonCode: statusCode,
          disconnectionObject: JSON.stringify(lastDisconnect),
        });

        // ✅ FIX 2.5: Timeout su update stato connessione close
        await withDbTimeout(
          this.prismaRepository.instance.update({
            where: { id: this.instanceId },
            data: {
              connectionStatus: 'close',
              disconnectionAt: new Date(),
              disconnectionReasonCode: statusCode,
              disconnectionObject: JSON.stringify(lastDisconnect),
            },
          }),
          'connectionUpdate:closeDefinitive',
        );

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
          this.chatwootService.eventWhatsapp(
            Events.STATUS_INSTANCE,
            { instanceName: this.instance.name, instanceId: this.instanceId },
            { instance: this.instance.name, status: 'closed' },
          );
        }

        this.eventEmitter.emit('logout.instance', this.instance.name, 'inner');
        this.client?.ws?.close();
        this.client.end(new Error('Close connection'));

        this.sendDataWebhook(Events.CONNECTION_UPDATE, { instance: this.instance.name, ...this.stateConnection });
      }
    }

    if (connection === 'open') {
      // Reset auto-restart tracking quando la connessione si apre con successo
      if (this.connectingTimer) {
        clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
      }

      // Log se auto-restart ha avuto successo
      if (this.isAutoRestarting) {
        this.logger.info(
          `[Auto-Restart] Instance ${this.instance.name} - SUCCESS! Connection restored after ${this.autoRestartAttempts} attempt(s)`,
        );
      }

      // ✅ FIX #1: Cancella safety timeout se connection raggiunge 'open'
      if (this.safetyTimeout) {
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
      }

      // ✅ FIX DEFINITIVO: Reset tutti i flag auto-restart quando connessione OK
      this.autoRestartAttempts = 0;
      this.wasOpenBeforeReconnect = false;
      this.isAutoRestarting = false;
      this.isAutoRestartTriggered = false;
      this.isRestartInProgress = false; // ← Nuovo flag
      this.lastConnectionState = 'open';

      // ✅ FIX #2: Reset force restart attempts su SUCCESS
      this.forceRestartAttempts = 0;
      this.lastForceRestartTime = 0;

      // ✅ DEFENSE IN DEPTH - Layer 2: Registra successo nel Circuit Breaker
      this.circuitBreaker.recordSuccess();
      this.safetyTimeoutRecursionDepth = 0; // Reset recursion counter
      this.globalRestartCounter = 0; // Reset global counter

      // ✅ DEFENSE IN DEPTH: Reset timer global restart counter
      if (this.globalRestartResetTimer) {
        clearTimeout(this.globalRestartResetTimer);
      }
      this.globalRestartResetTimer = setTimeout(() => {
        this.globalRestartCounter = 0;
      }, this.GLOBAL_RESTART_WINDOW);
      // ✅ FIX 2: Register timer to prevent memory leak
      this.resourceRegistry.addTimer(this.globalRestartResetTimer, 'globalRestartResetTimer');

      // ✅ BACKOFF: Reset delay e registra timestamp successo
      this.currentRestartDelay = this.MIN_RESTART_DELAY;
      this.lastSuccessfulConnection = Date.now();
      this.logger.info(
        `[Backoff] Instance ${this.instance.name} - Connection successful, delay reset to ${this.MIN_RESTART_DELAY}ms`,
      );

      // ✅ FASE 2: Update timestamp e avvia health check
      this.lastStateChangeTimestamp = Date.now();
      this.startHealthCheck();

      // ✅ DEFENSE IN DEPTH - Layer 3: Avvia heartbeat per watchdog esterno
      this.startHeartbeat();

      // ✅ FIX #8: Cache ownerJid per evitare query DB ripetute
      this.cachedOwnerJid = this.client.user.id.replace(/:\d+/, '');

      this.instance.wuid = this.client.user.id.replace(/:\d+/, '');
      try {
        const profilePic = await this.profilePicture(this.instance.wuid);
        this.instance.profilePictureUrl = profilePic.profilePictureUrl;
      } catch {
        this.instance.profilePictureUrl = null;
      }
      const formattedWuid = this.instance.wuid.split('@')[0].padEnd(30, ' ');
      const formattedName = this.instance.name;
      this.logger.info(
        `
        ┌──────────────────────────────┐
        │    CONNECTED TO WHATSAPP     │
        └──────────────────────────────┘`.replace(/^ +/gm, '  '),
      );
      this.logger.info(
        `
        wuid: ${formattedWuid}
        name: ${formattedName}
      `,
      );

      // ✅ FIX 2.5: Timeout su update stato connessione open
      await withDbTimeout(
        this.prismaRepository.instance.update({
          where: { id: this.instanceId },
          data: {
            ownerJid: this.instance.wuid,
            profileName: (await this.getProfileName()) as string,
            profilePicUrl: this.instance.profilePictureUrl,
            connectionStatus: 'open',
          },
        }),
        'connectionUpdate:open',
      );

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
        this.chatwootService.eventWhatsapp(
          Events.CONNECTION_UPDATE,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          { instance: this.instance.name, status: 'open' },
        );
        this.syncChatwootLostMessages();
      }

      this.sendDataWebhook(Events.CONNECTION_UPDATE, {
        instance: this.instance.name,
        wuid: this.instance.wuid,
        profileName: await this.getProfileName(),
        profilePictureUrl: this.instance.profilePictureUrl,
        ...this.stateConnection,
      });
    }

    if (connection === 'connecting') {
      this.sendDataWebhook(Events.CONNECTION_UPDATE, { instance: this.instance.name, ...this.stateConnection });

      // ✅ FIX #17: Health check continua durante connecting per backup safety net
      // Log condizionale (FIX #11) previene spam
      // Health check backup può rilevare flag bloccati anche durante connecting

      // Auto-restart logic quando l'istanza rimane in connecting (es. proxy IP change)
      // Usa flag wasOpenBeforeReconnect invece di lastConnectionState per evitare false negative
      this.lastConnectionState = 'connecting';

      // ✅ FASE 2: Update timestamp quando entra in connecting
      this.lastStateChangeTimestamp = Date.now();

      // ✅ FIX DEFINITIVO: Log dettagliato con tutti i flag per debug completo
      this.logger.verbose(
        `[Connection] Instance ${this.instance.name} - State: connecting | Flags: wasOpenBeforeReconnect=${this.wasOpenBeforeReconnect}, isAutoRestarting=${this.isAutoRestarting}, isRestartInProgress=${this.isRestartInProgress}, attempts=${this.autoRestartAttempts}/${this.maxAutoRestartAttempts}`,
      );

      // ✅ BACKOFF: Usa isRestartInProgress per prevenire duplicati
      // RIMOSSO limite autoRestartAttempts - ora usa exponential backoff infinito
      if (
        this.wasOpenBeforeReconnect &&
        !this.isRestartInProgress
        // ✅ RIMOSSO: this.autoRestartAttempts < this.maxAutoRestartAttempts
        // Non c'è più limite - usiamo exponential backoff per evitare blocco permanente
      ) {
        // Cancella timer precedente se esiste
        if (this.connectingTimer) {
          clearTimeout(this.connectingTimer);
        }

        // ✅ BACKOFF: Usa delay dinamico invece di fisso
        const restartDelay = this.getNextRestartDelay();
        this.logger.warn(
          `[Auto-Restart] Instance ${this.instance.name} - Detected stuck in 'connecting'. Will retry in ${restartDelay}ms (attempt ${this.autoRestartAttempts + 1}, no limit)...`,
        );

        // Avvia timer con delay dinamico (backoff)
        this.connectingTimer = setTimeout(() => {
          // Verifica che siamo ancora in stato 'connecting'
          if (this.stateConnection.state === 'connecting') {
            this.logger.warn(
              `[Auto-Restart] Instance ${this.instance.name} - Still in 'connecting' after ${restartDelay}ms. Triggering auto-restart...`,
            );
            this.autoRestart();
          } else {
            this.logger.info(
              `[Auto-Restart] Instance ${this.instance.name} - Timer expired but state changed to '${this.stateConnection.state}'. Auto-restart canceled.`,
            );
          }
        }, restartDelay);

        // ✅ FIX 1.1: Registra timer nel ResourceRegistry per tracking e cleanup automatico
        this.resourceRegistry.addTimer(this.connectingTimer, 'connectingTimer');
      } else {
        // Log spiegazione dettagliata
        if (!this.wasOpenBeforeReconnect) {
          this.logger.verbose(
            `[Auto-Restart] Instance ${this.instance.name} - ⏸️ Timer NOT started: wasOpenBeforeReconnect is false (first connection or definitive close)`,
          );
        } else if (this.isRestartInProgress) {
          this.logger.verbose(
            `[Auto-Restart] Instance ${this.instance.name} - ⏸️ Timer NOT started: restart operation in progress (isRestartInProgress=true)`,
          );
        } else {
          // Caso non previsto - log per debug
          this.logger.warn(
            `[Auto-Restart] Instance ${this.instance.name} - ⚠️ Timer NOT started: unexpected condition. Flags: wasOpenBeforeReconnect=${this.wasOpenBeforeReconnect}, isRestartInProgress=${this.isRestartInProgress}`,
          );
        }
      }
    }
  }

  /**
   * ✅ FIX DEFINITIVO: Auto-restart completamente riscritto per risolvere deadlock
   * PROBLEMA RISOLTO: Il vecchio codice settava isAutoRestarting=true e poi chiamava
   * il controller, ma quando il nuovo client entrava in "connecting", il timer NON
   * si avviava perché la condizione !isAutoRestarting era FALSE → deadlock
   *
   * SOLUZIONE: Resettare isAutoRestarting PRIMA di creare il nuovo client, così il
   * timer può avviarsi normalmente quando entra in "connecting"
   */
  private async autoRestart() {
    const restartStartTime = Date.now();

    try {
      // ✅ FIX: Previeni chiamate duplicate usando isRestartInProgress
      if (this.isRestartInProgress) {
        this.logger.warn(
          `[Auto-Restart] Instance ${this.instance.name} - Restart already in progress, skipping duplicate call`,
        );
        return;
      }

      // ✅ DEFENSE IN DEPTH - Layer 2: Check Circuit Breaker PRIMA di tutto
      if (!this.circuitBreaker.canExecute()) {
        this.logger.error(
          `[Auto-Restart] Instance ${this.instance.name} - ❌ Circuit Breaker is ${this.circuitBreaker.getState()}, refusing restart`,
        );
        return;
      }

      // ✅ DEFENSE IN DEPTH - Hard limit: contatore globale restart
      this.globalRestartCounter++;
      if (this.globalRestartCounter > this.GLOBAL_RESTART_MAX) {
        this.logger.error(
          `[Auto-Restart] Instance ${this.instance.name} - ❌ HARD LIMIT: ${this.globalRestartCounter} restarts in ${this.GLOBAL_RESTART_WINDOW / 1000}s window. Tripping circuit breaker.`,
        );
        this.circuitBreaker.tripCircuit('exceeded_global_restart_limit');
        return;
      }

      // ✅ DEFENSE IN DEPTH - Hard limit: max tentativi assoluto
      if (this.autoRestartAttempts >= this.HARD_MAX_RESTART_ATTEMPTS) {
        this.logger.error(
          `[Auto-Restart] Instance ${this.instance.name} - ❌ HARD LIMIT: ${this.autoRestartAttempts} attempts reached. Tripping circuit breaker.`,
        );
        this.circuitBreaker.tripCircuit('exceeded_hard_max_attempts');
        return;
      }

      this.isRestartInProgress = true; // ← Lock per prevenire duplicati
      this.isAutoRestartTriggered = true;
      this.autoRestartAttempts++;

      const state = this.stateConnection.state;

      this.logger.warn(
        `[Auto-Restart] Instance ${this.instance.name} - ⚠️ STARTING ATTEMPT ${this.autoRestartAttempts}/${this.maxAutoRestartAttempts} | Current state: ${state} | Timestamp: ${new Date().toISOString()}`,
      );

      // Verifica stato (come fa il restart manuale del controller)
      if (state === 'close') {
        this.logger.error(
          `[Auto-Restart] Instance ${this.instance.name} - ❌ Cannot restart: state is 'close' (definitively closed)`,
        );
        this.isRestartInProgress = false;
        this.isAutoRestartTriggered = false;
        return;
      }

      // Cleanup cache solo se era in stato 'open'
      if (state === 'open' && this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
        this.logger.verbose(`[Auto-Restart] Instance ${this.instance.name} - Clearing Chatwoot cache`);
        this.clearCacheChatwoot();
      }

      // ✅ FIX: Usa cleanupClient() per cleanup completo e consistente
      this.logger.info(`[Auto-Restart] Instance ${this.instance.name} - 🧹 Starting complete client cleanup...`);
      this.cleanupClient('auto-restart');

      // Aspetta che lo stato diventi 'close' prima di procedere
      this.logger.info(
        `[Auto-Restart] Instance ${this.instance.name} - ⏳ Waiting for state to become 'close' (max 5s)...`,
      );

      const stateChanged = await this.waitForState('close', 5000);

      if (!stateChanged) {
        this.logger.error(
          `[Auto-Restart] Instance ${this.instance.name} - ❌ Timeout: state did not become 'close' within 5s. Current state: ${this.stateConnection.state}`,
        );
        this.isRestartInProgress = false;
        this.isAutoRestartTriggered = false;
        return;
      }

      this.logger.info(
        `[Auto-Restart] Instance ${this.instance.name} - ✅ State is now 'close'. Proceeding with reconnection...`,
      );

      // ✅ FIX CRITICO: Ricarica proxy configuration dal DB PRIMA di riconnettere
      this.logger.info(`[Auto-Restart] Instance ${this.instance.name} - 🔄 Reloading proxy configuration...`);
      await this.loadProxy();

      // ✅ FIX CRITICO: Reset isAutoRestarting PRIMA di creare nuovo client
      // Questo permette al timer in connectionUpdate('connecting') di avviarsi normalmente
      this.logger.info(
        `[Auto-Restart] Instance ${this.instance.name} - 🔓 Resetting isAutoRestarting flag to allow timer activation`,
      );
      this.isAutoRestarting = false; // ← FIX DEADLOCK PRINCIPALE

      // ✅ FIX: Chiamata diretta a createClient invece di passare per controller
      // Più efficiente e meno race conditions
      this.logger.info(
        `[Auto-Restart] Instance ${this.instance.name} - 🔌 Creating new client (direct call to avoid controller overhead)...`,
      );
      await this.createClient(this.phoneNumber);

      // ✅ FIX #2: Verifica che il client sia stato creato correttamente
      if (!this.client) {
        throw new Error('createClient() completed but client is null - cannot proceed');
      }

      const restartDuration = Date.now() - restartStartTime;
      this.logger.info(
        `[Auto-Restart] Instance ${this.instance.name} - ✅ Client creation completed in ${restartDuration}ms. Waiting for connection state update...`,
      );

      // Reset lock dopo creazione client
      this.isRestartInProgress = false;

      // ✅ FIX: Safety timeout migliorato - Non solo reset flag ma TRIGGERA riconnessione attiva
      if (this.safetyTimeout) {
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
      }

      this.safetyTimeout = setTimeout(() => {
        const currentState = this.stateConnection.state;

        if (currentState !== 'open') {
          this.logger.error(
            `[Auto-Restart] Instance ${this.instance.name} - ⏰ Safety timeout: still in '${currentState}' after 30s`,
          );

          // ✅ FIX #6: Gestione corretta del safety timeout per evitare loop infinito
          if (currentState === 'connecting') {
            this.logger.warn(
              `[Auto-Restart] Instance ${this.instance.name} - 🔨 Safety timeout: forcing close and will retry with autoRestart()`,
            );

            // ✅ FIX #6: Setta flag PRIMA del close per prevenire reconnect automatico nel close handler
            this.isRestartInProgress = true;

            // Forza close del client
            if (this.client) {
              this.client.ws?.close();
              this.client.end(new Error('Safety timeout - forcing close to retry'));
            }

            // ✅ DEFENSE IN DEPTH: Limite recursione safety timeout
            this.safetyTimeoutRecursionDepth++;
            if (this.safetyTimeoutRecursionDepth >= this.HARD_MAX_RECURSION_DEPTH) {
              this.logger.error(
                `[Auto-Restart] Instance ${this.instance.name} - ❌ Safety timeout recursion LIMIT (${this.HARD_MAX_RECURSION_DEPTH}) reached. Tripping circuit breaker.`,
              );
              this.circuitBreaker.tripCircuit('safety_timeout_recursion_limit');
              this.circuitBreaker.recordFailure('safety_timeout_max_recursion');
              this.safetyTimeoutRecursionDepth = 0;
              this.isRestartInProgress = false;
              this.isAutoRestarting = false;
              this.isAutoRestartTriggered = false;
              return;
            }

            // ✅ FIX #6: Aspetta che il close si propaghi, poi riprova con autoRestart
            const autoRestartRetryTimer = setTimeout(() => {
              this.isRestartInProgress = false;
              this.isAutoRestarting = false;
              this.isAutoRestartTriggered = false;
              this.logger.info(
                `[Auto-Restart] Instance ${this.instance.name} - 🔄 Retrying connection via autoRestart() (recursion depth: ${this.safetyTimeoutRecursionDepth}/${this.HARD_MAX_RECURSION_DEPTH})...`,
              );
              this.autoRestart();
            }, 2000);
            // ✅ FIX 2: Register timer to prevent memory leak
            this.resourceRegistry.addTimer(autoRestartRetryTimer, 'autoRestartRetryTimer');

            this.sendDataWebhook(Events.INSTANCE_STUCK, {
              instance: this.instance.name,
              state: currentState,
              action: 'safety_timeout_triggered',
              reason: 'auto_restart_timeout',
              timeout: 30000,
              nextAction: 'controlled_retry_via_autoRestart',
            });
          } else {
            // Stato non è 'connecting' - solo reset flag
            this.isAutoRestarting = false;
            this.isAutoRestartTriggered = false;
            this.isRestartInProgress = false;

            this.sendDataWebhook(Events.INSTANCE_STUCK, {
              instance: this.instance.name,
              state: currentState,
              action: 'safety_timeout_triggered',
              reason: 'auto_restart_timeout',
              timeout: 30000,
              nextAction: 'flag_reset_only',
            });
          }
        }
        this.safetyTimeout = null;
      }, 30000);

      // ✅ FIX 1.1: Registra safety timeout nel ResourceRegistry per tracking e cleanup automatico
      this.resourceRegistry.addTimer(this.safetyTimeout, 'safetyTimeout-autoRestart');
    } catch (error) {
      this.logger.error(
        `[Auto-Restart] Instance ${this.instance.name} - ❌ Exception: ${error.toString()}\nStack: ${error.stack}`,
      );

      // Reset flag su errore (preserva wasOpenBeforeReconnect per future riconnessioni)
      this.isAutoRestarting = false;
      this.isAutoRestartTriggered = false;
      this.isRestartInProgress = false;

      // ✅ FIX BUG #4: wasOpenBeforeReconnect NON viene resettato qui
      // Preservato per permettere recovery automatico su prossima riconnessione
      // this.wasOpenBeforeReconnect = this.wasOpenBeforeReconnect;  // Mantiene valore

      // Cleanup safety timeout
      if (this.safetyTimeout) {
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
      }
    } finally {
      // ✅ FIX #1: SEMPRE resetta isRestartInProgress per evitare deadlock
      // Questo garantisce che anche in caso di eccezioni non catturate, il flag viene resettato
      if (this.isRestartInProgress) {
        this.logger.warn(
          `[Auto-Restart] Instance ${this.instance.name} - Finally block: ensuring isRestartInProgress=false`,
        );
        this.isRestartInProgress = false;
      }
    }
    // NOTA: isAutoRestarting viene resettato PRIMA di chiamare createClient (fix deadlock)
    // Safety timeout si occupa di reset in caso di problemi
  }

  /**
   * ✅ FIX 2: Rewritten to use setInterval instead of recursive setTimeout
   * This prevents memory leak from hundreds of untracked timers
   */
  private waitForState(expectedState: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      // Check immediately first
      if (this.stateConnection.state === expectedState) {
        resolve(true);
        return;
      }

      // Use single interval instead of recursive setTimeout
      const checkInterval = setInterval(() => {
        // Check state
        if (this.stateConnection.state === expectedState) {
          clearInterval(checkInterval);
          resolve(true);
          return;
        }

        // Check timeout
        if (Date.now() - startTime >= timeoutMs) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }
      }, 100); // Poll every 100ms

      // Register interval to prevent memory leak (will be cleaned on logout)
      this.resourceRegistry.addInterval(checkInterval, 'waitForStateCheck');
    });
  }

  /**
   * ✅ EXPONENTIAL BACKOFF: Calcola il prossimo delay per restart
   * Backoff: 5s → 10s → 20s → 30s (cap)
   * Si resetta quando la connessione è stabile per 2 minuti
   */
  private getNextRestartDelay(): number {
    // Se connessione era stabile per 2+ minuti, reset delay
    if (this.lastSuccessfulConnection > 0 && Date.now() - this.lastSuccessfulConnection > this.STABLE_CONNECTION_TIME) {
      this.currentRestartDelay = this.MIN_RESTART_DELAY;
      this.logger.info(
        `[Backoff] Instance ${this.instance.name} - Connection was stable, resetting delay to ${this.MIN_RESTART_DELAY}ms`,
      );
    }

    const delay = this.currentRestartDelay;

    // Aumenta per prossimo tentativo (cap a MAX 30s)
    this.currentRestartDelay = Math.min(this.currentRestartDelay * 2, this.MAX_RESTART_DELAY);

    this.logger.info(
      `[Backoff] Instance ${this.instance.name} - Current delay: ${delay}ms, next will be: ${this.currentRestartDelay}ms`,
    );

    return delay;
  }

  /**
   * ✅ FIX DEFINITIVO: Cleanup completo del client per prevenire memory leak e conflitti
   * Questa funzione esegue una pulizia completa di tutte le risorse associate al client WhatsApp
   */
  private cleanupClient(reason: string = 'cleanup'): void {
    const startTime = Date.now();
    this.logger.info(`[Cleanup] Instance ${this.instance.name} - Starting complete client cleanup (reason: ${reason})`);

    try {
      // 1. Chiudi WebSocket se aperto
      if (this.client?.ws) {
        this.logger.verbose(`[Cleanup] Instance ${this.instance.name} - Closing WebSocket connection`);
        try {
          this.client.ws.close();
        } catch (wsError) {
          this.logger.warn(`[Cleanup] Instance ${this.instance.name} - WebSocket close error: ${wsError.message}`);
        }
      }

      // 2. Termina il client Baileys
      if (this.client) {
        this.logger.verbose(`[Cleanup] Instance ${this.instance.name} - Ending Baileys client`);
        try {
          this.client.end(new Error(`Client cleanup: ${reason}`));
        } catch (clientError) {
          this.logger.warn(`[Cleanup] Instance ${this.instance.name} - Client end error: ${clientError.message}`);
        }
      }

      // 3. Clear tutti i timer attivi
      if (this.connectingTimer) {
        this.logger.verbose(`[Cleanup] Instance ${this.instance.name} - Clearing connecting timer`);
        clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
      }

      if (this.safetyTimeout) {
        this.logger.verbose(`[Cleanup] Instance ${this.instance.name} - Clearing safety timeout`);
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
      }

      // ✅ FIX CRITICO: Ferma healthCheck e heartbeat durante cleanup
      // Se non li fermiamo, continuano a operare su un client morto = memory leak + errori
      this.stopHealthCheck();
      this.stopHeartbeat();

      // 4. Nullifica reference del client (permette garbage collection)
      // NOTA: Non settiamo this.client = null perché createClient() lo sovrascriverà
      // e alcuni metodi potrebbero ancora referenziarlo durante la transizione

      const cleanupDuration = Date.now() - startTime;
      this.logger.info(`[Cleanup] Instance ${this.instance.name} - Client cleanup completed in ${cleanupDuration}ms`);
    } catch (error) {
      this.logger.error(`[Cleanup] Instance ${this.instance.name} - Error during cleanup: ${error.toString()}`);
    }
  }

  // ✅ FASE 2: Health Check System Functions

  /**
   * Avvia il health check periodico per monitorare lo stato dell'istanza
   * e rilevare problemi come blocchi in 'connecting' o proxy failures
   */
  private startHealthCheck() {
    // Ferma il timer precedente se esiste
    this.stopHealthCheck();

    // ✅ FIX #4: Jitter random ±10s per evitare thundering herd
    // Distribuisce health check su finestra 50-70s invece di spike a 60s
    const jitter = Math.random() * 20000 - 10000; // -10s a +10s
    const interval = this.healthCheckInterval + jitter;

    this.logger.info(
      `[HealthCheck] Instance ${this.instance.name} - Starting health check (interval: ${Math.round(interval / 1000)}s with jitter)`,
    );

    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error(
          `[HealthCheck] Instance ${this.instance.name} - Error during health check: ${error.toString()}`,
        );
      }
    }, interval); // ✅ Usa interval con jitter

    // ✅ FIX 1.1: Registra timer nel ResourceRegistry per tracking e cleanup automatico
    this.resourceRegistry.addInterval(this.healthCheckTimer, 'healthCheck');
  }

  /**
   * Ferma il health check periodico
   */
  private stopHealthCheck() {
    if (this.healthCheckTimer) {
      this.logger.info(`[HealthCheck] Instance ${this.instance.name} - Stopping health check`);
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ✅ DEFENSE IN DEPTH - Layer 3: Heartbeat Functions per Watchdog Esterno

  /**
   * Avvia il heartbeat periodico per il watchdog esterno
   * Il watchdog può rilevare istanze bloccate quando l'heartbeat smette di aggiornarsi
   */
  private startHeartbeat() {
    this.stopHeartbeat();

    this.logger.info(
      `[Heartbeat] Instance ${this.instance.name} - Starting heartbeat (interval: ${this.HEARTBEAT_INTERVAL / 1000}s)`,
    );

    // Prima update immediato
    this.updateHeartbeat().catch((err) => {
      this.logger.error(`[Heartbeat] Instance ${this.instance.name} - Initial heartbeat failed: ${err.message}`);
    });

    // Poi periodico
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.updateHeartbeat();
      } catch (error) {
        this.logger.error(`[Heartbeat] Instance ${this.instance.name} - Heartbeat update failed: ${error.message}`);
      }
    }, this.HEARTBEAT_INTERVAL);

    // ✅ FIX 1.1: Registra timer nel ResourceRegistry per tracking e cleanup automatico
    this.resourceRegistry.addInterval(this.heartbeatTimer, 'heartbeat');
  }

  /**
   * Ferma il heartbeat
   */
  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.logger.info(`[Heartbeat] Instance ${this.instance.name} - Stopping heartbeat`);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Aggiorna il record heartbeat nel database
   * Il watchdog esterno legge questo record per rilevare istanze bloccate
   */
  private async updateHeartbeat() {
    try {
      await withDbTimeout(
        this.prismaRepository.watchdogHeartbeat.upsert({
          where: { instanceId: this.instanceId },
          update: {
            lastHeartbeat: new Date(),
            state: this.stateConnection.state,
            processId: process.pid,
            circuitState: this.circuitBreaker.getState(),
          },
          create: {
            instanceId: this.instanceId,
            lastHeartbeat: new Date(),
            state: this.stateConnection.state,
            processId: process.pid,
            circuitState: this.circuitBreaker.getState(),
            recoveryAttempts: 0,
          },
        }),
        'updateHeartbeat',
      );
    } catch (error) {
      // Non loggare ogni errore per evitare spam - solo errori critici
      if (!(error instanceof TimeoutError)) {
        throw error;
      }
    }
  }

  /**
   * Logga un evento di health nel database per la dashboard
   */
  private async logHealthEvent(
    eventType: string,
    severity: 'info' | 'warn' | 'error' | 'critical',
    message: string,
    details?: Record<string, any>,
  ) {
    try {
      await withDbTimeout(
        this.prismaRepository.healthEvent.create({
          data: {
            instanceId: this.instanceId,
            eventType,
            severity,
            message,
            details: details || {},
          },
        }),
        'logHealthEvent',
      );
    } catch (error) {
      // Silently fail - non bloccare operazioni principali per log
      this.logger.warn(`[HealthEvent] Failed to log event: ${error.message}`);
    }
  }

  /**
   * Esegue un controllo di salute dell'istanza
   */
  private async performHealthCheck() {
    const state = this.stateConnection.state;
    const now = Date.now();
    const stateAge = now - this.lastStateChangeTimestamp;

    // ✅ FIX #11: Log condizionale - solo se stato cambia o milestone (ogni minuto)
    const shouldLog =
      !this.lastLoggedHealthState ||
      this.lastLoggedHealthState.state !== state ||
      (stateAge > 60000 && Math.floor(stateAge / 60000) !== Math.floor(this.lastLoggedHealthState.age / 60000));

    if (shouldLog) {
      this.logger.verbose(
        `[HealthCheck] Instance ${this.instance.name} - State: ${state}, Age: ${Math.round(stateAge / 1000)}s`,
      );
      this.lastLoggedHealthState = { state, age: stateAge };
    }

    // 0. Rileva flag isAutoRestarting bloccato (backup safety net se timeout in forceRestart fallisce)
    if (this.isAutoRestarting && state !== 'open' && stateAge > 60000) {
      this.logger.error(
        `[HealthCheck] Instance ${this.instance.name} - isAutoRestarting flag stuck for ${Math.round(stateAge / 1000)}s in state '${state}'. Forcing flag reset to allow reconnection.`,
      );

      this.sendDataWebhook(Events.INSTANCE_STUCK, {
        instance: this.instance.name,
        state: state,
        stuckDuration: Math.round(stateAge / 1000),
        threshold: 60000,
        lastStateChange: new Date(this.lastStateChangeTimestamp).toISOString(),
        action: 'reset_isAutoRestarting_flag',
        reason: 'auto_restart_flag_stuck',
      });

      this.isAutoRestarting = false;
      this.isAutoRestartTriggered = false;
      // ✅ FIX BUG #3: NON resettare wasOpenBeforeReconnect qui
      // Preservarlo permette recovery automatico su prossima riconnessione
      // this.wasOpenBeforeReconnect = false;  // ← RIMOSSO reset inappropriato
      this.autoRestartAttempts = 0;

      this.logger.warn(
        `[HealthCheck] Instance ${this.instance.name} - Flags reset (preserving wasOpenBeforeReconnect for recovery). Will attempt reconnection on next 'close' event.`,
      );

      return;
    }

    // 1. Rileva istanze bloccate in 'connecting' per più di 30 secondi - MA solo se già connesse prima
    if (state === 'connecting' && stateAge > this.stuckInConnectingThreshold) {
      // ✅ FIX #8: Usa cache ownerJid se disponibile (evita query DB ripetute)
      let ownerJid = this.cachedOwnerJid;

      // ✅ FIX #3: Se cache vuota, query DB con try-catch E TIMEOUT (fallback se DB down/slow)
      if (ownerJid === null && this.cachedOwnerJid === null) {
        try {
          // ✅ DEFENSE IN DEPTH - Layer 1: Timeout 5s su query DB
          const dbInstance = await withDbTimeout(
            this.prismaRepository.instance.findUnique({
              where: { id: this.instanceId },
              select: { ownerJid: true },
            }),
            'healthCheck-findOwnerJid',
          );
          ownerJid = dbInstance?.ownerJid || null;
          this.cachedOwnerJid = ownerJid; // ✅ Aggiorna cache
        } catch (dbError) {
          const isTimeout = dbError instanceof TimeoutError;
          this.logger.error(
            `[HealthCheck] Instance ${this.instance.name} - DB query ${isTimeout ? 'TIMEOUT' : 'failed'}: ${dbError.message}. Skipping force restart (safe fallback).`,
          );
          return; // ✅ Safe fallback: se DB down/slow, NON force restart
        }
      }

      // Se ownerJid è NULL, è una nuova istanza che aspetta il QR code → NON restartare
      if (ownerJid === null || ownerJid === undefined) {
        this.logger.info(
          `[HealthCheck] Instance ${this.instance.name} - First connection detected (no ownerJid). In 'connecting' state for ${Math.round(stateAge / 1000)}s waiting for QR code scan. Skipping force restart.`,
        );
        return; // ← Non fare restart!
      }

      // Se ownerJid esiste, l'istanza era già connessa → PROBLEMA reale!
      this.logger.warn(
        `[HealthCheck] Instance ${this.instance.name} - STUCK in 'connecting' for ${Math.round(stateAge / 1000)}s (was previously connected with ownerJid: ${ownerJid})`,
      );

      // ✅ Invia webhook event INSTANCE_STUCK con ownerJid info
      this.sendDataWebhook(Events.INSTANCE_STUCK, {
        instance: this.instance.name,
        state: state,
        stuckDuration: Math.round(stateAge / 1000),
        threshold: this.stuckInConnectingThreshold / 1000,
        lastStateChange: new Date(this.lastStateChangeTimestamp).toISOString(),
        action: 'force_restart',
        reason: 'stuck_in_reconnecting',
        ownerJid: ownerJid,
      });

      // ✅ FIX DEFINITIVO: Trigger force restart se non è già in corso (usa isRestartInProgress)
      if (!this.isRestartInProgress) {
        this.logger.warn(
          `[HealthCheck] Instance ${this.instance.name} - 🔨 Triggering force restart (no restart in progress)...`,
        );
        await this.forceRestart('Health check detected stuck in reconnecting state');
      } else {
        this.logger.info(
          `[HealthCheck] Instance ${this.instance.name} - ⏸️ Restart already in progress, skipping force restart`,
        );
      }
      return;
    }

    // 2. Test connessione proxy se abilitato e istanza è 'open'
    if (state === 'open' && this.localProxy?.enabled) {
      const proxyOk = await this.testProxyConnection();
      if (!proxyOk) {
        this.logger.warn(
          `[HealthCheck] Instance ${this.instance.name} - Proxy connection test FAILED. Triggering preventive restart...`,
        );

        // ✅ FASE 4: Invia webhook event INSTANCE_STUCK per proxy failure
        this.sendDataWebhook(Events.INSTANCE_STUCK, {
          instance: this.instance.name,
          state: state,
          action: 'preventive_restart',
          reason: 'proxy_connection_failure',
          proxyHost: this.localProxy.host,
          proxyPort: this.localProxy.port,
        });

        await this.forceRestart('Health check detected proxy connection failure');
      } else {
        this.logger.verbose(`[HealthCheck] Instance ${this.instance.name} - Proxy connection test OK`);
      }
    }
  }

  /**
   * Testa la connessione proxy con una richiesta HTTP semplice
   * ✅ FIX #8: Cache risultati per 2min per ridurre carico API esterna
   */
  private async testProxyConnection(): Promise<boolean> {
    if (!this.localProxy?.enabled) {
      return true; // Nessun proxy configurato
    }

    // ✅ CACHE ASIMMETRICA: fallimenti scadono più velocemente per riprovare dopo cambio IP
    const proxyKey = `${this.localProxy.host}:${this.localProxy.port}`;
    const cached = this.proxyTestCache.get(proxyKey);

    // TTL diversi: 5 min per successi, 30s per fallimenti
    const cacheTTL = cached?.result
      ? 300000 // 5 min per successi (proxy stabile)
      : 30000; // 30s per fallimenti (riprova veloce dopo cambio IP)

    if (cached && Date.now() - cached.timestamp < cacheTTL) {
      this.logger.verbose(
        `[HealthCheck] Instance ${this.instance.name} - Using cached proxy result: ${cached.result} (TTL: ${cacheTTL / 1000}s)`,
      );
      return cached.result;
    }

    try {
      this.logger.verbose(
        `[HealthCheck] Instance ${this.instance.name} - Testing proxy connection to ${this.localProxy.host}...`,
      );

      // Creo la stringa di proxy URL
      let proxyUrl: string;
      if (this.localProxy.username && this.localProxy.password) {
        proxyUrl = `${this.localProxy.protocol}://${this.localProxy.username}:${this.localProxy.password}@${this.localProxy.host}:${this.localProxy.port}`;
      } else {
        proxyUrl = `${this.localProxy.protocol}://${this.localProxy.host}:${this.localProxy.port}`;
      }

      // Test semplice: richiesta a un endpoint che restituisce l'IP pubblico
      const response = await axios.get('https://api.ipify.org?format=json', {
        proxy: false, // Disabilita proxy automatico axios
        httpsAgent: makeProxyAgent(proxyUrl),
        timeout: 10000, // 10 secondi timeout
      });

      if (response.status === 200 && response.data?.ip) {
        this.logger.verbose(
          `[HealthCheck] Instance ${this.instance.name} - Proxy test successful (IP: ${response.data.ip})`,
        );
        // ✅ FIX #8: Salva in cache
        this.proxyTestCache.set(proxyKey, { result: true, timestamp: Date.now() });
        return true;
      }

      this.logger.warn(`[HealthCheck] Instance ${this.instance.name} - Proxy test returned unexpected response`);
      // ✅ FIX #8: Salva in cache
      this.proxyTestCache.set(proxyKey, { result: false, timestamp: Date.now() });
      return false;
    } catch (error) {
      this.logger.warn(`[HealthCheck] Instance ${this.instance.name} - Proxy test failed: ${error.message}`);
      // ✅ FIX #8: Salva in cache
      this.proxyTestCache.set(proxyKey, { result: false, timestamp: Date.now() });
      return false;
    }
  }

  /**
   * ✅ FIX DEFINITIVO: Force restart completamente riscritto con stesso fix di autoRestart()
   * Risolve lo stesso deadlock applicando la stessa soluzione
   */
  private async forceRestart(reason: string) {
    const restartStartTime = Date.now();

    try {
      // ✅ FIX: Previeni race condition - usa isRestartInProgress invece di isAutoRestarting
      if (this.isRestartInProgress) {
        this.logger.warn(
          `[ForceRestart] Instance ${this.instance.name} - Restart already in progress, skipping duplicate call`,
        );
        return;
      }

      // ✅ BACKOFF: RIMOSSO limite rigido - usa exponential backoff invece
      // Il backoff in getNextRestartDelay() gestisce automaticamente i retry
      this.forceRestartAttempts++;
      this.logger.info(
        `[ForceRestart] Instance ${this.instance.name} - Attempt ${this.forceRestartAttempts} (no limit, using exponential backoff) | Reason: ${reason}`,
      );

      // ✅ FIX #4: Cancella timer esistenti PRIMA di settare i flag (previene race condition)
      if (this.connectingTimer) {
        clearTimeout(this.connectingTimer);
        this.connectingTimer = null;
        this.logger.info(`[ForceRestart] Instance ${this.instance.name} - Cleared existing connectingTimer`);
      }
      if (this.safetyTimeout) {
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
        this.logger.info(`[ForceRestart] Instance ${this.instance.name} - Cleared existing safetyTimeout`);
      }

      // Lock per prevenire chiamate duplicate
      this.isRestartInProgress = true;
      this.isAutoRestartTriggered = true;

      // ✅ FIX #0 BUG BLOCCO PERMANENTE: Cattura stato 'open' PRIMA del cleanup
      // Se forceRestart() è chiamato da stato 'open', dobbiamo preservare questa info
      // per permettere all'auto-restart timer di avviarsi in 'connecting'
      if (this.lastConnectionState === 'open') {
        this.wasOpenBeforeReconnect = true;
        this.logger.info(
          `[ForceRestart] Instance ${this.instance.name} - ✅ Setting wasOpenBeforeReconnect=true (restarting from 'open' state)`,
        );
      }

      // ✅ FIX: Usa cleanupClient() per cleanup completo
      this.logger.info(`[ForceRestart] Instance ${this.instance.name} - 🧹 Starting complete client cleanup...`);
      this.cleanupClient('force-restart');

      // Aspetta che diventi 'close'
      if (this.client) {
        this.logger.info(
          `[ForceRestart] Instance ${this.instance.name} - ⏳ Waiting for state to become 'close' (max 5s)...`,
        );

        const closed = await this.waitForState('close', 5000);
        if (!closed) {
          this.logger.error(
            `[ForceRestart] Instance ${this.instance.name} - ❌ Timeout waiting for 'close'. Current state: ${this.stateConnection.state}`,
          );
          this.isRestartInProgress = false;
          return;
        }
      }

      this.logger.info(
        `[ForceRestart] Instance ${this.instance.name} - ✅ State is now 'close'. Proceeding with reconnection...`,
      );

      // ✅ FIX: Ricarica proxy configuration
      this.logger.info(`[ForceRestart] Instance ${this.instance.name} - 🔄 Reloading proxy configuration...`);
      await this.loadProxy();

      // ✅ BACKOFF: Attendi prima di ricreare client (solo se non è primo tentativo)
      const backoffDelay = this.getNextRestartDelay();
      if (backoffDelay > this.MIN_RESTART_DELAY) {
        this.logger.info(
          `[ForceRestart] Instance ${this.instance.name} - ⏳ Waiting ${backoffDelay}ms before reconnection (backoff)...`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffDelay - this.MIN_RESTART_DELAY));
      }

      // ✅ FIX CRITICO: Reset isAutoRestarting PRIMA di creare nuovo client
      this.logger.info(
        `[ForceRestart] Instance ${this.instance.name} - 🔓 Resetting isAutoRestarting flag to allow timer activation`,
      );
      this.isAutoRestarting = false; // ← FIX DEADLOCK

      // ✅ FIX: Chiamata diretta a createClient
      this.logger.info(`[ForceRestart] Instance ${this.instance.name} - 🔌 Creating new client (direct call)...`);
      await this.createClient(this.phoneNumber);

      // ✅ FIX #2: Verifica che il client sia stato creato correttamente
      if (!this.client) {
        throw new Error('createClient() completed but client is null - cannot proceed');
      }

      const restartDuration = Date.now() - restartStartTime;
      this.logger.info(
        `[ForceRestart] Instance ${this.instance.name} - ✅ Client creation completed in ${restartDuration}ms`,
      );

      // Reset lock
      this.isRestartInProgress = false;

      // ✅ FIX: Safety timeout migliorato (identico a autoRestart)
      if (this.safetyTimeout) {
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
      }

      this.safetyTimeout = setTimeout(() => {
        const currentState = this.stateConnection.state;

        if (currentState !== 'open') {
          this.logger.error(
            `[ForceRestart] Instance ${this.instance.name} - ⏰ Safety timeout: still in '${currentState}' after 30s`,
          );

          // ✅ FIX #6: Gestione corretta del safety timeout per evitare loop infinito
          if (currentState === 'connecting') {
            this.logger.warn(
              `[ForceRestart] Instance ${this.instance.name} - 🔨 Safety timeout: forcing close and will retry with autoRestart()`,
            );

            // ✅ FIX #6: Setta flag PRIMA del close per prevenire reconnect automatico nel close handler
            this.isRestartInProgress = true;

            if (this.client) {
              this.client.ws?.close();
              this.client.end(new Error('Safety timeout - forcing close to retry'));
            }

            // ✅ FIX #6: Aspetta che il close si propaghi, poi riprova con autoRestart
            const forceRestartRetryTimer = setTimeout(() => {
              this.isRestartInProgress = false;
              this.isAutoRestarting = false;
              this.isAutoRestartTriggered = false;
              this.logger.info(
                `[ForceRestart] Instance ${this.instance.name} - 🔄 Retrying connection via autoRestart() after safety timeout...`,
              );
              this.autoRestart();
            }, 2000);
            // ✅ FIX 2: Register timer to prevent memory leak
            this.resourceRegistry.addTimer(forceRestartRetryTimer, 'forceRestartRetryTimer');

            this.sendDataWebhook(Events.INSTANCE_STUCK, {
              instance: this.instance.name,
              state: currentState,
              action: 'safety_timeout_triggered',
              reason: 'force_restart_timeout',
              timeout: 30000,
              nextAction: 'controlled_retry_via_autoRestart',
            });
          } else {
            // Stato non è 'connecting' - solo reset flag
            this.isAutoRestarting = false;
            this.isAutoRestartTriggered = false;
            this.isRestartInProgress = false;

            this.sendDataWebhook(Events.INSTANCE_STUCK, {
              instance: this.instance.name,
              state: currentState,
              action: 'safety_timeout_triggered',
              reason: 'force_restart_timeout',
              timeout: 30000,
              nextAction: 'flag_reset_only',
            });
          }
        }
        this.safetyTimeout = null;
      }, 30000);

      // ✅ FIX 1.1: Registra safety timeout nel ResourceRegistry per tracking e cleanup automatico
      this.resourceRegistry.addTimer(this.safetyTimeout, 'safetyTimeout-forceRestart');
    } catch (error) {
      this.logger.error(
        `[ForceRestart] Instance ${this.instance.name} - ❌ Exception: ${error.toString()}\nStack: ${error.stack}`,
      );

      // Reset flag su errore (preserva wasOpenBeforeReconnect per future riconnessioni)
      this.isAutoRestarting = false;
      this.isAutoRestartTriggered = false;
      this.isRestartInProgress = false;

      // ✅ FIX BUG #2: wasOpenBeforeReconnect NON viene resettato qui
      // Preservato per permettere recovery automatico su prossima riconnessione
      // this.wasOpenBeforeReconnect = this.wasOpenBeforeReconnect;  // Mantiene valore

      // Cleanup safety timeout
      if (this.safetyTimeout) {
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
      }
    } finally {
      // ✅ FIX #1: SEMPRE resetta isRestartInProgress per evitare deadlock
      // Questo garantisce che anche in caso di eccezioni non catturate, il flag viene resettato
      if (this.isRestartInProgress) {
        this.logger.warn(
          `[ForceRestart] Instance ${this.instance.name} - Finally block: ensuring isRestartInProgress=false`,
        );
        this.isRestartInProgress = false;
      }
    }
  }

  private async getMessage(key: proto.IMessageKey, full = false) {
    try {
      // Use raw SQL to avoid JSON path issues
      const webMessageInfo = (await withDbTimeout(
        this.prismaRepository.$queryRaw`
          SELECT * FROM "Message"
          WHERE "instanceId" = ${this.instanceId}
          AND "key"->>'id' = ${key.id}
        `,
        'getMessage:queryRaw',
      )) as proto.IWebMessageInfo[];

      if (full) {
        return webMessageInfo[0];
      }
      if (webMessageInfo[0].message?.pollCreationMessage) {
        const messageSecretBase64 = webMessageInfo[0].message?.messageContextInfo?.messageSecret;

        if (typeof messageSecretBase64 === 'string') {
          const messageSecret = Buffer.from(messageSecretBase64, 'base64');

          const msg = {
            messageContextInfo: { messageSecret },
            pollCreationMessage: webMessageInfo[0].message?.pollCreationMessage,
          };

          return msg;
        }
      }

      return webMessageInfo[0].message;
    } catch {
      return { conversation: '' };
    }
  }

  private async defineAuthState() {
    const db = this.configService.get<Database>('DATABASE');
    const cache = this.configService.get<CacheConf>('CACHE');

    const provider = this.configService.get<ProviderSession>('PROVIDER');

    if (provider?.ENABLED) {
      return await this.authStateProvider.authStateProvider(this.instance.id);
    }

    if (cache?.REDIS.ENABLED && cache?.REDIS.SAVE_INSTANCES) {
      this.logger.info('Redis enabled');
      return await useMultiFileAuthStateRedisDb(this.instance.id, this.cache);
    }

    if (db.SAVE_DATA.INSTANCE) {
      return await useMultiFileAuthStatePrisma(this.instance.id, this.cache);
    }
  }

  private async createClient(number?: string): Promise<WASocket> {
    this.instance.authState = await this.defineAuthState();

    const session = this.configService.get<ConfigSessionPhone>('CONFIG_SESSION_PHONE');

    let browserOptions = {};

    if (number || this.phoneNumber) {
      this.phoneNumber = number;

      this.logger.info(`Phone number: ${number}`);
    } else {
      const browser: WABrowserDescription = [session.CLIENT, session.NAME, release()];
      browserOptions = { browser };

      this.logger.info(`Browser: ${browser}`);
    }

    const baileysVersion = await fetchLatestWaWebVersion({});
    const version = baileysVersion.version;
    const log = `Baileys version: ${version.join('.')}`;

    // if (session.VERSION) {
    //   version = session.VERSION.split('.');
    //   log = `Baileys version env: ${version}`;
    // } else {
    //   const baileysVersion = await fetchLatestWaWebVersion({});
    //   version = baileysVersion.version;
    //   log = `Baileys version: ${version}`;
    // }

    this.logger.info(log);

    this.logger.info(`Group Ignore: ${this.localSettings.groupsIgnore}`);

    let options;

    if (this.localProxy?.enabled) {
      this.logger.info('Proxy enabled: ' + this.localProxy?.host);

      if (this.localProxy?.host?.includes('proxyscrape')) {
        try {
          // ✅ FIX HTTP TIMEOUT: Proxy list fetch con timeout 15s
          const response = await withHttpTimeout(axios.get(this.localProxy?.host), 'proxyListFetch');
          const text = response.data;
          const proxyUrls = text.split('\r\n');
          const rand = Math.floor(Math.random() * Math.floor(proxyUrls.length));
          const proxyUrl = 'http://' + proxyUrls[rand];
          options = { agent: makeProxyAgent(proxyUrl), fetchAgent: makeProxyAgentUndici(proxyUrl) };
        } catch {
          this.localProxy.enabled = false;
        }
      } else {
        options = {
          agent: makeProxyAgent({
            host: this.localProxy.host,
            port: this.localProxy.port,
            protocol: this.localProxy.protocol,
            username: this.localProxy.username,
            password: this.localProxy.password,
          }),
          fetchAgent: makeProxyAgentUndici({
            host: this.localProxy.host,
            port: this.localProxy.port,
            protocol: this.localProxy.protocol,
            username: this.localProxy.username,
            password: this.localProxy.password,
          }),
        };
      }
    }

    const socketConfig: UserFacingSocketConfig = {
      ...options,
      version,
      logger: P({ level: this.logBaileys }),
      printQRInTerminal: false,
      auth: {
        creds: this.instance.authState.state.creds,
        keys: makeCacheableSignalKeyStore(this.instance.authState.state.keys, P({ level: 'error' }) as any),
      },
      msgRetryCounterCache: this.msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => (await this.getMessage(key)) as Promise<proto.IMessage>,
      ...browserOptions,
      markOnlineOnConnect: this.localSettings.alwaysOnline,
      retryRequestDelayMs: 350,
      maxMsgRetryCount: 4,
      fireInitQueries: true,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 30_000,
      qrTimeout: 45_000,
      emitOwnEvents: false,
      shouldIgnoreJid: (jid) => {
        if (this.localSettings.syncFullHistory && isJidGroup(jid)) {
          return false;
        }

        const isGroupJid = this.localSettings.groupsIgnore && isJidGroup(jid);
        const isBroadcast = !this.localSettings.readStatus && isJidBroadcast(jid);
        const isNewsletter = isJidNewsletter(jid);

        return isGroupJid || isBroadcast || isNewsletter;
      },
      syncFullHistory: this.localSettings.syncFullHistory,
      shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => {
        return this.historySyncNotification(msg);
      },
      cachedGroupMetadata: this.getGroupMetadataCache,
      userDevicesCache: this.userDevicesCache,
      transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
      patchMessageBeforeSending(message) {
        if (
          message.deviceSentMessage?.message?.listMessage?.listType === proto.Message.ListMessage.ListType.PRODUCT_LIST
        ) {
          message = JSON.parse(JSON.stringify(message));

          message.deviceSentMessage.message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
        }

        if (message.listMessage?.listType == proto.Message.ListMessage.ListType.PRODUCT_LIST) {
          message = JSON.parse(JSON.stringify(message));

          message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
        }

        return message;
      },
    };

    this.endSession = false;

    this.client = makeWASocket(socketConfig);

    if (this.localSettings.wavoipToken && this.localSettings.wavoipToken.length > 0) {
      useVoiceCallsBaileys(this.localSettings.wavoipToken, this.client, this.connectionStatus.state as any, true);
    }

    this.eventHandler();

    // ✅ FIX 7: Registra WS listeners nel ResourceRegistry per tracking e cleanup
    const cbCallHandler = (packet: unknown) => {
      console.log('CB:call', packet);
      const payload = { event: 'CB:call', packet: packet };
      this.sendDataWebhook(Events.CALL, payload, true, ['websocket']);
    };
    this.client.ws.on('CB:call', cbCallHandler);
    this.resourceRegistry.addListener('ws-cb-call', this.client.ws, 'CB:call', cbCallHandler);

    const cbAckCallHandler = (packet: unknown) => {
      console.log('CB:ack,class:call', packet);
      const payload = { event: 'CB:ack,class:call', packet: packet };
      this.sendDataWebhook(Events.CALL, payload, true, ['websocket']);
    };
    this.client.ws.on('CB:ack,class:call', cbAckCallHandler);
    this.resourceRegistry.addListener('ws-cb-ack-call', this.client.ws, 'CB:ack,class:call', cbAckCallHandler);

    this.phoneNumber = number;

    return this.client;
  }

  public async connectToWhatsapp(number?: string): Promise<WASocket> {
    try {
      this.loadChatwoot();
      this.loadSettings();
      this.loadWebhook();
      this.loadProxy();

      return await this.createClient(number);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  public async reloadConnection(): Promise<WASocket> {
    try {
      return await this.createClient(this.phoneNumber);
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString());
    }
  }

  private readonly chatHandle = {
    'chats.upsert': async (chats: Chat[]) => {
      // ✅ FIX 1: Wrap DB query with timeout
      const existingChatIds = await withDbTimeout(
        this.prismaRepository.chat.findMany({
          where: { instanceId: this.instanceId },
          select: { remoteJid: true },
        }),
        'chatHandle:findMany',
      );

      const existingChatIdSet = new Set(existingChatIds.map((chat) => chat.remoteJid));

      const chatsToInsert = chats
        .filter((chat) => !existingChatIdSet?.has(chat.id))
        .map((chat) => ({
          remoteJid: chat.id,
          instanceId: this.instanceId,
          name: chat.name,
          unreadMessages: chat.unreadCount !== undefined ? chat.unreadCount : 0,
        }));

      this.sendDataWebhook(Events.CHATS_UPSERT, chatsToInsert);

      if (chatsToInsert.length > 0) {
        if (this.configService.get<Database>('DATABASE').SAVE_DATA.CHATS)
          // ✅ FIX 1: Wrap DB query with timeout
          await withDbTimeout(
            this.prismaRepository.chat.createMany({ data: chatsToInsert, skipDuplicates: true }),
            'chatHandle:createMany',
          );
      }
    },

    'chats.update': async (
      chats: Partial<
        proto.IConversation & { lastMessageRecvTimestamp?: number } & {
          conditional: (bufferedData: BufferedEventData) => boolean;
        }
      >[],
    ) => {
      const chatsRaw = chats.map((chat) => {
        return { remoteJid: chat.id, instanceId: this.instanceId };
      });

      this.sendDataWebhook(Events.CHATS_UPDATE, chatsRaw);

      for (const chat of chats) {
        // ✅ FIX 1: Wrap DB query with timeout
        await withDbTimeout(
          this.prismaRepository.chat.updateMany({
            where: { instanceId: this.instanceId, remoteJid: chat.id, name: chat.name },
            data: { remoteJid: chat.id },
          }),
          'chatHandle:updateMany',
        );
      }
    },

    'chats.delete': async (chats: string[]) => {
      // ✅ FIX 1: Wrap DB queries with timeout (using for...of instead of forEach for proper await)
      for (const chat of chats) {
        await withDbTimeout(
          this.prismaRepository.chat.deleteMany({ where: { instanceId: this.instanceId, remoteJid: chat } }),
          'chatHandle:deleteMany',
        );
      }

      this.sendDataWebhook(Events.CHATS_DELETE, [...chats]);
    },
  };

  private readonly contactHandle = {
    'contacts.upsert': async (contacts: Contact[]) => {
      try {
        const contactsRaw: any = contacts.map((contact) => ({
          remoteJid: contact.id,
          pushName: contact?.name || contact?.verifiedName || contact.id.split('@')[0],
          profilePicUrl: null,
          instanceId: this.instanceId,
        }));

        if (contactsRaw.length > 0) {
          this.sendDataWebhook(Events.CONTACTS_UPSERT, contactsRaw);

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.CONTACTS)
            // ✅ FIX 1: Wrap DB query with timeout
            await withDbTimeout(
              this.prismaRepository.contact.createMany({ data: contactsRaw, skipDuplicates: true }),
              'contactHandle:createMany',
            );

          const usersContacts = contactsRaw.filter((c) => c.remoteJid.includes('@s.whatsapp'));
          if (usersContacts) {
            await saveOnWhatsappCache(usersContacts.map((c) => ({ remoteJid: c.remoteJid })));
          }
        }

        if (
          this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
          this.localChatwoot?.enabled &&
          this.localChatwoot.importContacts &&
          contactsRaw.length
        ) {
          this.chatwootService.addHistoryContacts(
            { instanceName: this.instance.name, instanceId: this.instance.id },
            contactsRaw,
          );
          chatwootImport.importHistoryContacts(
            { instanceName: this.instance.name, instanceId: this.instance.id },
            this.localChatwoot,
          );
        }

        const updatedContacts = await Promise.all(
          contacts.map(async (contact) => ({
            remoteJid: contact.id,
            pushName: contact?.name || contact?.verifiedName || contact.id.split('@')[0],
            profilePicUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
            instanceId: this.instanceId,
          })),
        );

        if (updatedContacts.length > 0) {
          const usersContacts = updatedContacts.filter((c) => c.remoteJid.includes('@s.whatsapp'));
          if (usersContacts) {
            await saveOnWhatsappCache(usersContacts.map((c) => ({ remoteJid: c.remoteJid })));
          }

          this.sendDataWebhook(Events.CONTACTS_UPDATE, updatedContacts);
          await Promise.all(
            updatedContacts.map(async (contact) => {
              // ✅ FIX 1: Wrap DB query with timeout
              const update = withDbTimeout(
                this.prismaRepository.contact.updateMany({
                  where: { remoteJid: contact.remoteJid, instanceId: this.instanceId },
                  data: { profilePicUrl: contact.profilePicUrl },
                }),
                'contactHandle:updateMany',
              );

              if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
                const instance = { instanceName: this.instance.name, instanceId: this.instance.id };

                const findParticipant = await this.chatwootService.findContact(
                  instance,
                  contact.remoteJid.split('@')[0],
                );

                if (!findParticipant) {
                  return;
                }

                this.chatwootService.updateContact(instance, findParticipant.id, {
                  name: contact.pushName,
                  avatar_url: contact.profilePicUrl,
                });
              }

              return update;
            }),
          );
        }
      } catch (error) {
        console.error(error);
        this.logger.error(`Error: ${error.message}`);
      }
    },

    'contacts.update': async (contacts: Partial<Contact>[]) => {
      const contactsRaw: { remoteJid: string; pushName?: string; profilePicUrl?: string; instanceId: string }[] = [];
      for await (const contact of contacts) {
        this.logger.debug(`Updating contact: ${JSON.stringify(contact, null, 2)}`);
        contactsRaw.push({
          remoteJid: contact.id,
          pushName: contact?.name ?? contact?.verifiedName,
          profilePicUrl: (await this.profilePicture(contact.id)).profilePictureUrl,
          instanceId: this.instanceId,
        });
      }

      this.sendDataWebhook(Events.CONTACTS_UPDATE, contactsRaw);

      const updateTransactions = contactsRaw.map((contact) =>
        this.prismaRepository.contact.upsert({
          where: { remoteJid_instanceId: { remoteJid: contact.remoteJid, instanceId: contact.instanceId } },
          create: contact,
          update: contact,
        }),
      );
      // ✅ FIX 1: Wrap DB transaction with timeout
      await withDbTimeout(this.prismaRepository.$transaction(updateTransactions), 'contactHandle:transaction');

      //const usersContacts = contactsRaw.filter((c) => c.remoteJid.includes('@s.whatsapp'));
    },
  };

  private readonly messageHandle = {
    'messaging-history.set': async ({
      messages,
      chats,
      contacts,
      isLatest,
      progress,
      syncType,
    }: {
      chats: Chat[];
      contacts: Contact[];
      messages: WAMessage[];
      isLatest?: boolean;
      progress?: number;
      syncType?: proto.HistorySync.HistorySyncType;
    }) => {
      try {
        if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
          console.log('received on-demand history sync, messages=', messages);
        }
        console.log(
          `recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`,
        );

        const instance: InstanceDto = { instanceName: this.instance.name };

        let timestampLimitToImport = null;

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
          const daysLimitToImport = this.localChatwoot?.enabled ? this.localChatwoot.daysLimitImportMessages : 1000;

          const date = new Date();
          timestampLimitToImport = new Date(date.setDate(date.getDate() - daysLimitToImport)).getTime() / 1000;

          const maxBatchTimestamp = Math.max(...messages.map((message) => message.messageTimestamp as number));

          const processBatch = maxBatchTimestamp >= timestampLimitToImport;

          if (!processBatch) {
            return;
          }
        }

        const contactsMap = new Map();

        for (const contact of contacts) {
          if (contact.id && (contact.notify || contact.name)) {
            contactsMap.set(contact.id, { name: contact.name ?? contact.notify, jid: contact.id });
          }
        }

        const chatsRaw: { remoteJid: string; instanceId: string; name?: string }[] = [];
        // ✅ FIX 1: Wrap DB query with timeout
        const chatsRepository = new Set(
          (
            await withDbTimeout(
              this.prismaRepository.chat.findMany({ where: { instanceId: this.instanceId } }),
              'historySync:chatFindMany',
            )
          ).map((chat) => chat.remoteJid),
        );

        for (const chat of chats) {
          if (chatsRepository?.has(chat.id)) {
            continue;
          }

          chatsRaw.push({ remoteJid: chat.id, instanceId: this.instanceId, name: chat.name });
        }

        this.sendDataWebhook(Events.CHATS_SET, chatsRaw);

        if (this.configService.get<Database>('DATABASE').SAVE_DATA.HISTORIC) {
          // ✅ FIX 1: Wrap DB query with timeout
          await withDbTimeout(
            this.prismaRepository.chat.createMany({ data: chatsRaw, skipDuplicates: true }),
            'historySync:chatCreateMany',
          );
        }

        const messagesRaw: any[] = [];

        // ✅ FIX 1: Wrap DB query with timeout
        const messagesRepository: Set<string> = new Set(
          chatwootImport.getRepositoryMessagesCache(instance) ??
            (
              await withDbTimeout(
                this.prismaRepository.message.findMany({
                  select: { key: true },
                  where: { instanceId: this.instanceId },
                }),
                'historySync:messageFindMany',
              )
            ).map((message) => {
              const key = message.key as { id: string };

              return key.id;
            }),
        );

        if (chatwootImport.getRepositoryMessagesCache(instance) === null) {
          chatwootImport.setRepositoryMessagesCache(instance, messagesRepository);
        }

        for (const m of messages) {
          if (!m.message || !m.key || !m.messageTimestamp) {
            continue;
          }

          if (Long.isLong(m?.messageTimestamp)) {
            m.messageTimestamp = m.messageTimestamp?.toNumber();
          }

          if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
            if (m.messageTimestamp <= timestampLimitToImport) {
              continue;
            }
          }

          if (messagesRepository?.has(m.key.id)) {
            continue;
          }

          if (!m.pushName && !m.key.fromMe) {
            const participantJid = m.participant || m.key.participant || m.key.remoteJid;
            if (participantJid && contactsMap.has(participantJid)) {
              m.pushName = contactsMap.get(participantJid).name;
            } else if (participantJid) {
              m.pushName = participantJid.split('@')[0];
            }
          }

          messagesRaw.push(this.prepareMessage(m));
        }

        this.sendDataWebhook(Events.MESSAGES_SET, [...messagesRaw]);

        if (this.configService.get<Database>('DATABASE').SAVE_DATA.HISTORIC) {
          // ✅ FIX 1: Wrap DB query with timeout
          await withDbTimeout(
            this.prismaRepository.message.createMany({ data: messagesRaw, skipDuplicates: true }),
            'historySync:messageCreateMany',
          );
        }

        if (
          this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
          this.localChatwoot?.enabled &&
          this.localChatwoot.importMessages &&
          messagesRaw.length > 0
        ) {
          this.chatwootService.addHistoryMessages(
            instance,
            messagesRaw.filter((msg) => !chatwootImport.isIgnorePhoneNumber(msg.key?.remoteJid)),
          );
        }

        await this.contactHandle['contacts.upsert'](
          contacts.filter((c) => !!c.notify || !!c.name).map((c) => ({ id: c.id, name: c.name ?? c.notify })),
        );

        contacts = undefined;
        messages = undefined;
        chats = undefined;
      } catch (error) {
        this.logger.error(error);
      }
    },

    'messages.upsert': async (
      { messages, type, requestId }: { messages: WAMessage[]; type: MessageUpsertType; requestId?: string },
      settings: any,
    ) => {
      try {
        for (const received of messages) {
          if (
            received?.messageStubParameters?.some?.((param) =>
              [
                'No matching sessions found for message',
                'Bad MAC',
                'failed to decrypt message',
                'SessionError',
                'Invalid PreKey ID',
                'No session record',
                'No session found to decrypt message',
              ].some((err) => param?.includes?.(err)),
            )
          ) {
            this.logger.warn(`Message ignored with messageStubParameters: ${JSON.stringify(received, null, 2)}`);
            continue;
          }
          if (received.message?.conversation || received.message?.extendedTextMessage?.text) {
            const text = received.message?.conversation || received.message?.extendedTextMessage?.text;

            if (text == 'requestPlaceholder' && !requestId) {
              const messageId = await this.client.requestPlaceholderResend(received.key);

              console.log('requested placeholder resync, id=', messageId);
            } else if (requestId) {
              console.log('Message received from phone, id=', requestId, received);
            }

            if (text == 'onDemandHistSync') {
              const messageId = await this.client.fetchMessageHistory(50, received.key, received.messageTimestamp!);
              console.log('requested on-demand sync, id=', messageId);
            }
          }

          const editedMessage =
            received?.message?.protocolMessage || received?.message?.editedMessage?.message?.protocolMessage;

          if (editedMessage) {
            if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled)
              this.chatwootService.eventWhatsapp(
                'messages.edit',
                { instanceName: this.instance.name, instanceId: this.instance.id },
                editedMessage,
              );

            await this.sendDataWebhook(Events.MESSAGES_EDITED, editedMessage);
            const oldMessage = await this.getMessage(editedMessage.key, true);
            if ((oldMessage as any)?.id) {
              const editedMessageTimestamp = Long.isLong(received?.messageTimestamp)
                ? Math.floor(received?.messageTimestamp.toNumber())
                : Math.floor(received?.messageTimestamp as number);

              // ✅ FIX 1: Wrap DB query with timeout
              await withDbTimeout(
                this.prismaRepository.message.update({
                  where: { id: (oldMessage as any).id },
                  data: {
                    message: editedMessage.editedMessage as any,
                    messageTimestamp: editedMessageTimestamp,
                    status: 'EDITED',
                  },
                }),
                'messagesUpsert:messageUpdate',
              );
              // ✅ FIX 1: Wrap DB query with timeout
              await withDbTimeout(
                this.prismaRepository.messageUpdate.create({
                  data: {
                    fromMe: editedMessage.key.fromMe,
                    keyId: editedMessage.key.id,
                    remoteJid: editedMessage.key.remoteJid,
                    status: 'EDITED',
                    instanceId: this.instanceId,
                    messageId: (oldMessage as any).id,
                  },
                }),
                'messagesUpsert:messageUpdateCreate',
              );
            }
          }

          const messageKey = `${this.instance.id}_${received.key.id}`;
          const cached = await withRedisTimeout(this.baileysCache.get(messageKey), 'messagesUpsert:checkDuplicate');

          if (cached && !editedMessage && !requestId) {
            this.logger.info(`Message duplicated ignored: ${received.key.id}`);
            continue;
          }

          await withRedisTimeout(
            this.baileysCache.set(messageKey, true, this.MESSAGE_CACHE_TTL_SECONDS),
            'messagesUpsert:setDuplicate',
          );

          if (
            (type !== 'notify' && type !== 'append') ||
            editedMessage ||
            received.message?.pollUpdateMessage ||
            !received?.message
          ) {
            continue;
          }

          if (Long.isLong(received.messageTimestamp)) {
            received.messageTimestamp = received.messageTimestamp?.toNumber();
          }

          if (settings?.groupsIgnore && received.key.remoteJid.includes('@g.us')) {
            continue;
          }

          // ✅ FIX 1: Wrap DB query with timeout
          const existingChat = await withDbTimeout(
            this.prismaRepository.chat.findFirst({
              where: { instanceId: this.instanceId, remoteJid: received.key.remoteJid },
              select: { id: true, name: true },
            }),
            'messagesUpsert:chatFindFirst',
          );

          if (
            existingChat &&
            received.pushName &&
            existingChat.name !== received.pushName &&
            received.pushName.trim().length > 0 &&
            !received.key.fromMe &&
            !received.key.remoteJid.includes('@g.us')
          ) {
            this.sendDataWebhook(Events.CHATS_UPSERT, [{ ...existingChat, name: received.pushName }]);
            if (this.configService.get<Database>('DATABASE').SAVE_DATA.CHATS) {
              try {
                // ✅ FIX 1: Wrap DB query with timeout
                await withDbTimeout(
                  this.prismaRepository.chat.update({
                    where: { id: existingChat.id },
                    data: { name: received.pushName },
                  }),
                  'messagesUpsert:chatUpdate',
                );
              } catch {
                console.log(`Chat insert record ignored: ${received.key.remoteJid} - ${this.instanceId}`);
              }
            }
          }

          const messageRaw = this.prepareMessage(received);

          const isMedia =
            received?.message?.imageMessage ||
            received?.message?.videoMessage ||
            received?.message?.stickerMessage ||
            received?.message?.documentMessage ||
            received?.message?.documentWithCaptionMessage ||
            received?.message?.ptvMessage ||
            received?.message?.audioMessage;

          const isVideo = received?.message?.videoMessage;

          if (this.localSettings.readMessages && received.key.id !== 'status@broadcast') {
            await this.client.readMessages([received.key]);
          }

          if (this.localSettings.readStatus && received.key.id === 'status@broadcast') {
            await this.client.readMessages([received.key]);
          }

          if (
            this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
            this.localChatwoot?.enabled &&
            !received.key.id.includes('@broadcast')
          ) {
            const chatwootSentMessage = await this.chatwootService.eventWhatsapp(
              Events.MESSAGES_UPSERT,
              { instanceName: this.instance.name, instanceId: this.instanceId },
              messageRaw,
            );

            if (chatwootSentMessage?.id) {
              messageRaw.chatwootMessageId = chatwootSentMessage.id;
              messageRaw.chatwootInboxId = chatwootSentMessage.inbox_id;
              messageRaw.chatwootConversationId = chatwootSentMessage.conversation_id;
            }
          }

          if (this.configService.get<Openai>('OPENAI').ENABLED && received?.message?.audioMessage) {
            // ✅ FIX 1: Wrap DB query with timeout
            const openAiDefaultSettings = await withDbTimeout(
              this.prismaRepository.openaiSetting.findFirst({
                where: { instanceId: this.instanceId },
                include: { OpenaiCreds: true },
              }),
              'messagesUpsert:openaiSettingFind',
            );

            if (openAiDefaultSettings && openAiDefaultSettings.openaiCredsId && openAiDefaultSettings.speechToText) {
              messageRaw.message.speechToText = `[audio] ${await this.openaiService.speechToText(received, this)}`;
            }
          }

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE) {
            // ✅ FIX 1: Wrap DB query with timeout
            const msg = await withDbTimeout(
              this.prismaRepository.message.create({ data: messageRaw }),
              'messagesUpsert:messageCreate',
            );

            const { remoteJid } = received.key;
            const timestamp = msg.messageTimestamp;
            const fromMe = received.key.fromMe.toString();
            const messageKey = `${remoteJid}_${timestamp}_${fromMe}`;

            const cachedTimestamp = await withRedisTimeout(
              this.baileysCache.get(messageKey),
              'messagesUpsert:checkPolling',
            );

            if (!cachedTimestamp) {
              if (!received.key.fromMe) {
                if (msg.status === status[3]) {
                  this.logger.log(`Update not read messages ${remoteJid}`);
                  await this.updateChatUnreadMessages(remoteJid);
                } else if (msg.status === status[4]) {
                  this.logger.log(`Update readed messages ${remoteJid} - ${timestamp}`);
                  await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);
                }
              } else {
                // is send message by me
                this.logger.log(`Update readed messages ${remoteJid} - ${timestamp}`);
                await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);
              }

              await withRedisTimeout(
                this.baileysCache.set(messageKey, true, this.MESSAGE_CACHE_TTL_SECONDS),
                'messagesUpsert:setPolling',
              );
            } else {
              this.logger.info(`Update readed messages duplicated ignored [avoid deadlock]: ${messageKey}`);
            }

            if (isMedia) {
              if (this.configService.get<S3>('S3').ENABLE) {
                try {
                  if (isVideo && !this.configService.get<S3>('S3').SAVE_VIDEO) {
                    this.logger.warn('Video upload is disabled. Skipping video upload.');
                    // Skip video upload by returning early from this block
                    return;
                  }

                  const message: any = received;

                  // Verificação adicional para garantir que há conteúdo de mídia real
                  const hasRealMedia = this.hasValidMediaContent(message);

                  if (!hasRealMedia) {
                    this.logger.warn('Message detected as media but contains no valid media content');
                  } else {
                    const media = await this.getBase64FromMediaMessage({ message }, true);

                    const { buffer, mediaType, fileName, size } = media;
                    const mimetype = mimeTypes.lookup(fileName).toString();
                    const fullName = join(
                      `${this.instance.id}`,
                      received.key.remoteJid,
                      mediaType,
                      `${Date.now()}_${fileName}`,
                    );
                    await s3Service.uploadFile(fullName, buffer, size.fileLength?.low, { 'Content-Type': mimetype });

                    // ✅ FIX 1: Wrap DB query with timeout
                    await withDbTimeout(
                      this.prismaRepository.media.create({
                        data: {
                          messageId: msg.id,
                          instanceId: this.instanceId,
                          type: mediaType,
                          fileName: fullName,
                          mimetype,
                        },
                      }),
                      'messagesUpsert:mediaCreate',
                    );

                    const mediaUrl = await s3Service.getObjectUrl(fullName);

                    messageRaw.message.mediaUrl = mediaUrl;

                    // ✅ FIX 1: Wrap DB query with timeout
                    await withDbTimeout(
                      this.prismaRepository.message.update({ where: { id: msg.id }, data: messageRaw }),
                      'messagesUpsert:messageUpdate2',
                    );
                  }
                } catch (error) {
                  this.logger.error(['Error on upload file to minio', error?.message, error?.stack]);
                }
              }
            }
          }

          if (this.localWebhook.enabled) {
            if (isMedia && this.localWebhook.webhookBase64) {
              try {
                const buffer = await downloadMediaMessage(
                  { key: received.key, message: received?.message },
                  'buffer',
                  {},
                  { logger: P({ level: 'error' }) as any, reuploadRequest: this.client.updateMediaMessage },
                );

                if (buffer) {
                  messageRaw.message.base64 = buffer.toString('base64');
                } else {
                  // retry to download media
                  const buffer = await downloadMediaMessage(
                    { key: received.key, message: received?.message },
                    'buffer',
                    {},
                    { logger: P({ level: 'error' }) as any, reuploadRequest: this.client.updateMediaMessage },
                  );

                  if (buffer) {
                    messageRaw.message.base64 = buffer.toString('base64');
                  }
                }
              } catch (error) {
                this.logger.error(['Error converting media to base64', error?.message]);
              }
            }
          }

          this.logger.verbose(messageRaw);

          sendTelemetry(`received.message.${messageRaw.messageType ?? 'unknown'}`);

          this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);

          await chatbotController.emit({
            instance: { instanceName: this.instance.name, instanceId: this.instanceId },
            remoteJid: messageRaw.key.remoteJid,
            msg: messageRaw,
            pushName: messageRaw.pushName,
          });

          // ✅ FIX 1: Wrap DB query with timeout
          const contact = await withDbTimeout(
            this.prismaRepository.contact.findFirst({
              where: { remoteJid: received.key.remoteJid, instanceId: this.instanceId },
            }),
            'messagesUpsert:contactFindFirst',
          );

          const contactRaw: {
            remoteJid: string;
            pushName: string;
            profilePicUrl?: string;
            instanceId: string;
          } = {
            remoteJid: received.key.remoteJid,
            pushName: received.key.fromMe ? '' : received.key.fromMe == null ? '' : received.pushName,
            profilePicUrl: (await this.profilePicture(received.key.remoteJid)).profilePictureUrl,
            instanceId: this.instanceId,
          };

          if (contactRaw.remoteJid === 'status@broadcast') {
            continue;
          }

          if (contactRaw.remoteJid.includes('@s.whatsapp') || contactRaw.remoteJid.includes('@lid')) {
            await saveOnWhatsappCache([
              {
                remoteJid:
                  messageRaw.key.addressingMode === 'lid' ? messageRaw.key.remoteJidAlt : messageRaw.key.remoteJid,
                remoteJidAlt: messageRaw.key.remoteJidAlt,
                lid: messageRaw.key.addressingMode === 'lid' ? 'lid' : null,
              },
            ]);
          }

          if (contact) {
            this.sendDataWebhook(Events.CONTACTS_UPDATE, contactRaw);

            if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
              await this.chatwootService.eventWhatsapp(
                Events.CONTACTS_UPDATE,
                { instanceName: this.instance.name, instanceId: this.instanceId },
                contactRaw,
              );
            }

            if (this.configService.get<Database>('DATABASE').SAVE_DATA.CONTACTS)
              // ✅ FIX 1: Wrap DB query with timeout
              await withDbTimeout(
                this.prismaRepository.contact.upsert({
                  where: {
                    remoteJid_instanceId: { remoteJid: contactRaw.remoteJid, instanceId: contactRaw.instanceId },
                  },
                  create: contactRaw,
                  update: contactRaw,
                }),
                'messagesUpsert:contactUpsert1',
              );

            continue;
          }

          this.sendDataWebhook(Events.CONTACTS_UPSERT, contactRaw);

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.CONTACTS)
            // ✅ FIX 1: Wrap DB query with timeout
            await withDbTimeout(
              this.prismaRepository.contact.upsert({
                where: { remoteJid_instanceId: { remoteJid: contactRaw.remoteJid, instanceId: contactRaw.instanceId } },
                update: contactRaw,
                create: contactRaw,
              }),
              'messagesUpsert:contactUpsert2',
            );
        }
      } catch (error) {
        this.logger.error(error);
      }
    },

    'messages.update': async (args: { update: Partial<WAMessage>; key: WAMessageKey }[], settings: any) => {
      this.logger.verbose(`Update messages ${JSON.stringify(args, undefined, 2)}`);

      const readChatToUpdate: Record<string, true> = {}; // {remoteJid: true}

      for await (const { key, update } of args) {
        if (settings?.groupsIgnore && key.remoteJid?.includes('@g.us')) {
          continue;
        }

        if (update.message !== null && update.status === undefined) continue;

        const updateKey = `${this.instance.id}_${key.id}_${update.status}`;

        const cached = await withRedisTimeout(this.baileysCache.get(updateKey), 'messagesUpdate:checkDuplicate');

        if (cached) {
          this.logger.info(`Message duplicated ignored [avoid deadlock]: ${updateKey}`);
          continue;
        }

        await withRedisTimeout(this.baileysCache.set(updateKey, true, 30 * 60), 'messagesUpdate:setDuplicate');

        if (status[update.status] === 'READ' && key.fromMe) {
          if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
            this.chatwootService.eventWhatsapp(
              'messages.read',
              { instanceName: this.instance.name, instanceId: this.instanceId },
              { key: key },
            );
          }
        }

        if (key.remoteJid !== 'status@broadcast' && key.id !== undefined) {
          let pollUpdates: any;

          if (update.pollUpdates) {
            const pollCreation = await this.getMessage(key);

            if (pollCreation) {
              pollUpdates = getAggregateVotesInPollMessage({
                message: pollCreation as proto.IMessage,
                pollUpdates: update.pollUpdates,
              });
            }
          }

          const message: any = {
            keyId: key.id,
            remoteJid: key?.remoteJid,
            fromMe: key.fromMe,
            participant: key?.participant,
            status: status[update.status] ?? 'DELETED',
            pollUpdates,
            instanceId: this.instanceId,
          };

          let findMessage: any;
          const configDatabaseData = this.configService.get<Database>('DATABASE').SAVE_DATA;
          if (configDatabaseData.HISTORIC || configDatabaseData.NEW_MESSAGE) {
            // ✅ FIX 1: Wrap DB query with timeout
            // Use raw SQL to avoid JSON path issues
            const messages = (await withDbTimeout(
              this.prismaRepository.$queryRaw`
                SELECT * FROM "Message"
                WHERE "instanceId" = ${this.instanceId}
                AND "key"->>'id' = ${key.id}
                LIMIT 1
              `,
              'messagesUpdate:queryRaw',
            )) as any[];
            findMessage = messages[0] || null;

            if (!findMessage?.id) {
              this.logger.warn(`Original message not found for update. Skipping. Key: ${JSON.stringify(key)}`);
              continue;
            }
            message.messageId = findMessage.id;
          }

          if (update.message === null && update.status === undefined) {
            this.sendDataWebhook(Events.MESSAGES_DELETE, key);

            if (this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE)
              // ✅ FIX 1: Wrap DB query with timeout
              await withDbTimeout(
                this.prismaRepository.messageUpdate.create({ data: message }),
                'messagesUpdate:messageUpdateCreate',
              );

            if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
              this.chatwootService.eventWhatsapp(
                Events.MESSAGES_DELETE,
                { instanceName: this.instance.name, instanceId: this.instanceId },
                { key: key },
              );
            }

            continue;
          }

          if (findMessage && update.status !== undefined && status[update.status] !== findMessage.status) {
            if (!key.fromMe && key.remoteJid) {
              readChatToUpdate[key.remoteJid] = true;

              const { remoteJid } = key;
              const timestamp = findMessage.messageTimestamp;
              const fromMe = key.fromMe.toString();
              const messageKey = `${remoteJid}_${timestamp}_${fromMe}`;

              const cachedTimestamp = await withRedisTimeout(
                this.baileysCache.get(messageKey),
                'messageUpdate:checkDuplicate',
              );

              if (!cachedTimestamp) {
                if (status[update.status] === status[4]) {
                  this.logger.log(`Update as read in message.update ${remoteJid} - ${timestamp}`);
                  await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);
                  await withRedisTimeout(
                    this.baileysCache.set(messageKey, true, this.MESSAGE_CACHE_TTL_SECONDS),
                    'messageUpdate:setDuplicate',
                  );
                }

                // ✅ FIX 1: Wrap DB query with timeout
                await withDbTimeout(
                  this.prismaRepository.message.update({
                    where: { id: findMessage.id },
                    data: { status: status[update.status] },
                  }),
                  'messagesUpdate:messageUpdate',
                );
              } else {
                this.logger.info(
                  `Update readed messages duplicated ignored in message.update [avoid deadlock]: ${messageKey}`,
                );
              }
            }
          }

          this.sendDataWebhook(Events.MESSAGES_UPDATE, message);

          if (this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE)
            // ✅ FIX 1: Wrap DB query with timeout
            await withDbTimeout(
              this.prismaRepository.messageUpdate.create({ data: message }),
              'messagesUpdate:messageUpdateCreate2',
            );

          // ✅ FIX 1: Wrap DB query with timeout
          const existingChat = await withDbTimeout(
            this.prismaRepository.chat.findFirst({
              where: { instanceId: this.instanceId, remoteJid: message.remoteJid },
            }),
            'messagesUpdate:chatFindFirst',
          );

          if (existingChat) {
            const chatToInsert = { remoteJid: message.remoteJid, instanceId: this.instanceId, unreadMessages: 0 };

            this.sendDataWebhook(Events.CHATS_UPSERT, [chatToInsert]);
            if (this.configService.get<Database>('DATABASE').SAVE_DATA.CHATS) {
              try {
                // ✅ FIX 1: Wrap DB query with timeout
                await withDbTimeout(
                  this.prismaRepository.chat.update({ where: { id: existingChat.id }, data: chatToInsert }),
                  'messagesUpdate:chatUpdate',
                );
              } catch {
                console.log(`Chat insert record ignored: ${chatToInsert.remoteJid} - ${chatToInsert.instanceId}`);
              }
            }
          }
        }
      }

      await Promise.all(Object.keys(readChatToUpdate).map((remoteJid) => this.updateChatUnreadMessages(remoteJid)));
    },
  };

  private readonly groupHandler = {
    'groups.upsert': (groupMetadata: GroupMetadata[]) => {
      this.sendDataWebhook(Events.GROUPS_UPSERT, groupMetadata);
    },

    'groups.update': (groupMetadataUpdate: Partial<GroupMetadata>[]) => {
      this.sendDataWebhook(Events.GROUPS_UPDATE, groupMetadataUpdate);

      groupMetadataUpdate.forEach((group) => {
        if (isJidGroup(group.id)) {
          this.updateGroupMetadataCache(group.id);
        }
      });
    },

    'group-participants.update': async (participantsUpdate: {
      id: string;
      participants: string[];
      action: ParticipantAction;
    }) => {
      // ENHANCEMENT: Adds participantsData field while maintaining backward compatibility
      // MAINTAINS: participants: string[] (original JID strings)
      // ADDS: participantsData: { jid: string, phoneNumber: string, name?: string, imgUrl?: string }[]
      // This enables LID to phoneNumber conversion without breaking existing webhook consumers

      // Helper to normalize participantId as phone number
      const normalizePhoneNumber = (id: string): string => {
        // Remove @lid, @s.whatsapp.net suffixes and extract just the number part
        return id.split('@')[0];
      };

      try {
        // Usa o mesmo método que o endpoint /group/participants
        const groupParticipants = await this.findParticipants({ groupJid: participantsUpdate.id });

        // Validação para garantir que temos dados válidos
        if (!groupParticipants?.participants || !Array.isArray(groupParticipants.participants)) {
          throw new Error('Invalid participant data received from findParticipants');
        }

        // Filtra apenas os participantes que estão no evento
        const resolvedParticipants = participantsUpdate.participants.map((participantId) => {
          const participantData = groupParticipants.participants.find((p) => p.id === participantId);

          let phoneNumber: string;
          if (participantData?.phoneNumber) {
            phoneNumber = participantData.phoneNumber;
          } else {
            phoneNumber = normalizePhoneNumber(participantId);
          }

          return {
            jid: participantId,
            phoneNumber,
            name: participantData?.name,
            imgUrl: participantData?.imgUrl,
          };
        });

        // Mantém formato original + adiciona dados resolvidos
        const enhancedParticipantsUpdate = {
          ...participantsUpdate,
          participants: participantsUpdate.participants, // Mantém array original de strings
          // Adiciona dados resolvidos em campo separado
          participantsData: resolvedParticipants,
        };

        this.sendDataWebhook(Events.GROUP_PARTICIPANTS_UPDATE, enhancedParticipantsUpdate);
      } catch (error) {
        this.logger.error(
          `Failed to resolve participant data for GROUP_PARTICIPANTS_UPDATE webhook: ${error.message} | Group: ${participantsUpdate.id} | Participants: ${participantsUpdate.participants.length}`,
        );
        // Fallback - envia sem conversão
        this.sendDataWebhook(Events.GROUP_PARTICIPANTS_UPDATE, participantsUpdate);
      }

      this.updateGroupMetadataCache(participantsUpdate.id);
    },
  };

  private readonly labelHandle = {
    [Events.LABELS_EDIT]: async (label: Label) => {
      this.sendDataWebhook(Events.LABELS_EDIT, { ...label, instance: this.instance.name });

      // ✅ FIX 1: Wrap DB query with timeout
      const labelsRepository = await withDbTimeout(
        this.prismaRepository.label.findMany({ where: { instanceId: this.instanceId } }),
        'labelHandle:findMany',
      );

      const savedLabel = labelsRepository.find((l) => l.labelId === label.id);
      if (label.deleted && savedLabel) {
        // ✅ FIX 1: Wrap DB query with timeout
        await withDbTimeout(
          this.prismaRepository.label.delete({
            where: { labelId_instanceId: { instanceId: this.instanceId, labelId: label.id } },
          }),
          'labelHandle:delete',
        );
        this.sendDataWebhook(Events.LABELS_EDIT, { ...label, instance: this.instance.name });
        return;
      }

      const labelName = label.name.replace(/[^\x20-\x7E]/g, '');
      if (!savedLabel || savedLabel.color !== `${label.color}` || savedLabel.name !== labelName) {
        if (this.configService.get<Database>('DATABASE').SAVE_DATA.LABELS) {
          const labelData = {
            color: `${label.color}`,
            name: labelName,
            labelId: label.id,
            predefinedId: label.predefinedId,
            instanceId: this.instanceId,
          };
          // ✅ FIX 1: Wrap DB query with timeout
          await withDbTimeout(
            this.prismaRepository.label.upsert({
              where: { labelId_instanceId: { instanceId: labelData.instanceId, labelId: labelData.labelId } },
              update: labelData,
              create: labelData,
            }),
            'labelHandle:upsert',
          );
        }
      }
    },

    [Events.LABELS_ASSOCIATION]: async (
      data: { association: LabelAssociation; type: 'remove' | 'add' },
      database: Database,
    ) => {
      this.logger.info(
        `labels association - ${data?.association?.chatId} (${data.type}-${data?.association?.type}): ${data?.association?.labelId}`,
      );
      if (database.SAVE_DATA.CHATS) {
        const instanceId = this.instanceId;
        const chatId = data.association.chatId;
        const labelId = data.association.labelId;

        if (data.type === 'add') {
          await this.addLabel(labelId, instanceId, chatId);
        } else if (data.type === 'remove') {
          await this.removeLabel(labelId, instanceId, chatId);
        }
      }

      this.sendDataWebhook(Events.LABELS_ASSOCIATION, {
        instance: this.instance.name,
        type: data.type,
        chatId: data.association.chatId,
        labelId: data.association.labelId,
      });
    },
  };

  private eventHandler() {
    this.client.ev.process(async (events) => {
      // ✅ FIX CRITICO: Try/catch per prevenire crash dell'event processor
      // Se un handler lancia un'eccezione, l'intero event processor si blocca
      try {
        if (!this.endSession) {
          const database = this.configService.get<Database>('DATABASE');
          const settings = await this.findSettings();

          if (events.call) {
            const call = events.call[0];

            if (settings?.rejectCall && call.status == 'offer') {
              this.client.rejectCall(call.id, call.from);
            }

            if (settings?.msgCall?.trim().length > 0 && call.status == 'offer') {
              if (call.from.endsWith('@lid')) {
                call.from = await this.client.signalRepository.lidMapping.getPNForLID(call.from as string);
              }
              const msg = await this.client.sendMessage(call.from, { text: settings.msgCall });

              this.client.ev.emit('messages.upsert', { messages: [msg], type: 'notify' });
            }

            this.sendDataWebhook(Events.CALL, call);
          }

          if (events['connection.update']) {
            // ✅ FIX #9: Await per sequenzializzare eventi e prevenire race conditions
            await this.connectionUpdate(events['connection.update']);
          }

          if (events['creds.update']) {
            this.instance.authState.saveCreds();
          }

          if (events['messaging-history.set']) {
            const payload = events['messaging-history.set'];
            this.messageHandle['messaging-history.set'](payload);
          }

          if (events['messages.upsert']) {
            const payload = events['messages.upsert'];

            this.messageProcessor.processMessage(payload, settings);
            // this.messageHandle['messages.upsert'](payload, settings);
          }

          if (events['messages.update']) {
            const payload = events['messages.update'];
            this.messageHandle['messages.update'](payload, settings);
          }

          if (events['message-receipt.update']) {
            const payload = events['message-receipt.update'] as MessageUserReceiptUpdate[];
            const remotesJidMap: Record<string, number> = {};

            for (const event of payload) {
              if (typeof event.key.remoteJid === 'string' && typeof event.receipt.readTimestamp === 'number') {
                remotesJidMap[event.key.remoteJid] = event.receipt.readTimestamp;
              }
            }

            await Promise.all(
              Object.keys(remotesJidMap).map(async (remoteJid) =>
                this.updateMessagesReadedByTimestamp(remoteJid, remotesJidMap[remoteJid]),
              ),
            );
          }

          if (events['presence.update']) {
            const payload = events['presence.update'];

            if (settings?.groupsIgnore && payload.id.includes('@g.us')) {
              return;
            }

            this.sendDataWebhook(Events.PRESENCE_UPDATE, payload);
          }

          if (!settings?.groupsIgnore) {
            if (events['groups.upsert']) {
              const payload = events['groups.upsert'];
              this.groupHandler['groups.upsert'](payload);
            }

            if (events['groups.update']) {
              const payload = events['groups.update'];
              this.groupHandler['groups.update'](payload);
            }

            if (events['group-participants.update']) {
              const payload = events['group-participants.update'] as any;
              this.groupHandler['group-participants.update'](payload);
            }
          }

          if (events['chats.upsert']) {
            const payload = events['chats.upsert'];
            this.chatHandle['chats.upsert'](payload);
          }

          if (events['chats.update']) {
            const payload = events['chats.update'];
            this.chatHandle['chats.update'](payload);
          }

          if (events['chats.delete']) {
            const payload = events['chats.delete'];
            this.chatHandle['chats.delete'](payload);
          }

          if (events['contacts.upsert']) {
            const payload = events['contacts.upsert'];
            this.contactHandle['contacts.upsert'](payload);
          }

          if (events['contacts.update']) {
            const payload = events['contacts.update'];
            this.contactHandle['contacts.update'](payload);
          }

          if (events[Events.LABELS_ASSOCIATION]) {
            const payload = events[Events.LABELS_ASSOCIATION];
            this.labelHandle[Events.LABELS_ASSOCIATION](payload, database);
            return;
          }

          if (events[Events.LABELS_EDIT]) {
            const payload = events[Events.LABELS_EDIT];
            this.labelHandle[Events.LABELS_EDIT](payload);
            return;
          }
        }
      } catch (error) {
        // ✅ FIX CRITICO: Cattura errori per evitare che l'event processor muoia
        // Non rilanciare - permettere al processor di continuare con il prossimo evento
        this.logger.error(
          `[EventProcessor] Instance ${this.instance.name} - Error processing events: ${error?.message || error}`,
        );
        // Log stack trace per debug
        if (error?.stack) {
          this.logger.error(`[EventProcessor] Stack: ${error.stack}`);
        }
      }
    });
  }

  private historySyncNotification(msg: proto.Message.IHistorySyncNotification) {
    const instance: InstanceDto = { instanceName: this.instance.name };

    if (
      this.configService.get<Chatwoot>('CHATWOOT').ENABLED &&
      this.localChatwoot?.enabled &&
      this.localChatwoot.importMessages &&
      this.isSyncNotificationFromUsedSyncType(msg)
    ) {
      if (msg.chunkOrder === 1) {
        this.chatwootService.startImportHistoryMessages(instance);
      }

      if (msg.progress === 100) {
        const chatwootImportTimer = setTimeout(() => {
          this.chatwootService.importHistoryMessages(instance);
        }, 10000);
        // ✅ FIX 2: Register timer to prevent memory leak
        this.resourceRegistry.addTimer(chatwootImportTimer, 'chatwootImportTimer');
      }
    }

    return true;
  }

  private isSyncNotificationFromUsedSyncType(msg: proto.Message.IHistorySyncNotification) {
    return (
      (this.localSettings.syncFullHistory && msg?.syncType === 2) ||
      (!this.localSettings.syncFullHistory && msg?.syncType === 3)
    );
  }

  public async profilePicture(number: string) {
    const jid = createJid(number);

    try {
      const profilePictureUrl = await this.client.profilePictureUrl(jid, 'image');

      return { wuid: jid, profilePictureUrl };
    } catch {
      return { wuid: jid, profilePictureUrl: null };
    }
  }

  public async getStatus(number: string) {
    const jid = createJid(number);

    try {
      return { wuid: jid, status: (await this.client.fetchStatus(jid))[0]?.status };
    } catch {
      return { wuid: jid, status: null };
    }
  }

  public async fetchProfile(instanceName: string, number?: string) {
    const jid = number ? createJid(number) : this.client?.user?.id;

    const onWhatsapp = (await this.whatsappNumber({ numbers: [jid] }))?.shift();

    if (!onWhatsapp.exists) {
      throw new BadRequestException(onWhatsapp);
    }

    try {
      if (number) {
        const info = (await this.whatsappNumber({ numbers: [jid] }))?.shift();
        const picture = await this.profilePicture(info?.jid);
        const status = await this.getStatus(info?.jid);
        const business = await this.fetchBusinessProfile(info?.jid);

        return {
          wuid: info?.jid || jid,
          name: info?.name,
          numberExists: info?.exists,
          picture: picture?.profilePictureUrl,
          status: status?.status,
          isBusiness: business.isBusiness,
          email: business?.email,
          description: business?.description,
          website: business?.website?.shift(),
        };
      } else {
        const instanceNames = instanceName ? [instanceName] : null;
        const info: Instance = await waMonitor.instanceInfo(instanceNames);
        const business = await this.fetchBusinessProfile(jid);

        return {
          wuid: jid,
          name: info?.profileName,
          numberExists: true,
          picture: info?.profilePicUrl,
          status: info?.connectionStatus,
          isBusiness: business.isBusiness,
          email: business?.email,
          description: business?.description,
          website: business?.website?.shift(),
        };
      }
    } catch {
      return { wuid: jid, name: null, picture: null, status: null, os: null, isBusiness: false };
    }
  }

  public async offerCall({ number, isVideo, callDuration }: OfferCallDto) {
    const jid = createJid(number);

    try {
      // const call = await this.client.offerCall(jid, isVideo);
      // setTimeout(() => this.client.terminateCall(call.id, call.to), callDuration * 1000);

      // return call;
      return { id: '123', jid, isVideo, callDuration };
    } catch (error) {
      return error;
    }
  }

  private async sendMessage(
    sender: string,
    message: any,
    mentions: any,
    linkPreview: any,
    quoted: any,
    messageId?: string,
    ephemeralExpiration?: number,
    contextInfo?: any,
    // participants?: GroupParticipant[],
  ) {
    sender = sender.toLowerCase();

    const option: any = { quoted };

    if (isJidGroup(sender)) {
      option.useCachedGroupMetadata = true;
      // if (participants)
      //   option.cachedGroupMetadata = async () => {
      //     return { participants: participants as GroupParticipant[] };
      //   };
    }

    if (ephemeralExpiration) option.ephemeralExpiration = ephemeralExpiration;

    // NOTE: NÃO DEVEMOS GERAR O messageId AQUI, SOMENTE SE VIER INFORMADO POR PARAMETRO. A GERAÇÃO ANTERIOR IMPEDE O WZAP DE IDENTIFICAR A SOURCE.
    if (messageId) option.messageId = messageId;

    if (message['viewOnceMessage']) {
      const m = generateWAMessageFromContent(sender, message, {
        timestamp: new Date(),
        userJid: this.instance.wuid,
        messageId,
        quoted,
      });
      const id = await this.client.relayMessage(sender, message, { messageId });
      m.key = { id: id, remoteJid: sender, participant: isPnUser(sender) ? sender : undefined, fromMe: true };
      for (const [key, value] of Object.entries(m)) {
        if (!value || (isArray(value) && value.length) === 0) {
          delete m[key];
        }
      }
      return m;
    }

    if (
      !message['audio'] &&
      !message['poll'] &&
      !message['sticker'] &&
      !message['conversation'] &&
      sender !== 'status@broadcast'
    ) {
      if (message['reactionMessage']) {
        return await this.client.sendMessage(
          sender,
          {
            react: { text: message['reactionMessage']['text'], key: message['reactionMessage']['key'] },
          } as unknown as AnyMessageContent,
          option as unknown as MiscMessageGenerationOptions,
        );
      }
    }

    if (contextInfo) {
      message['contextInfo'] = contextInfo;
    }

    if (message['conversation']) {
      return await this.client.sendMessage(
        sender,
        {
          text: message['conversation'],
          mentions,
          linkPreview: linkPreview,
          contextInfo: message['contextInfo'],
        } as unknown as AnyMessageContent,
        option as unknown as MiscMessageGenerationOptions,
      );
    }

    if (!message['audio'] && !message['poll'] && !message['sticker'] && sender != 'status@broadcast') {
      return await this.client.sendMessage(
        sender,
        {
          forward: { key: { remoteJid: this.instance.wuid, fromMe: true }, message },
          mentions,
          contextInfo: message['contextInfo'],
        },
        option as unknown as MiscMessageGenerationOptions,
      );
    }

    if (sender === 'status@broadcast') {
      let jidList;
      if (message['status'].option.allContacts) {
        const contacts = await withDbTimeout(
          this.prismaRepository.contact.findMany({
            where: { instanceId: this.instanceId, remoteJid: { not: { endsWith: '@g.us' } } },
          }),
          'statusBroadcast:findContacts',
        );

        jidList = contacts.map((contact) => contact.remoteJid);
      } else {
        jidList = message['status'].option.statusJidList;
      }

      const batchSize = 10;

      const batches = Array.from({ length: Math.ceil(jidList.length / batchSize) }, (_, i) =>
        jidList.slice(i * batchSize, i * batchSize + batchSize),
      );

      let msgId: string | null = null;

      let firstMessage: WAMessage;

      const firstBatch = batches.shift();

      if (firstBatch) {
        firstMessage = await this.client.sendMessage(
          sender,
          message['status'].content as unknown as AnyMessageContent,
          {
            backgroundColor: message['status'].option.backgroundColor,
            font: message['status'].option.font,
            statusJidList: firstBatch,
          } as unknown as MiscMessageGenerationOptions,
        );

        msgId = firstMessage.key.id;
      }

      if (batches.length === 0) return firstMessage;

      await Promise.allSettled(
        batches.map(async (batch) => {
          const messageSent = await this.client.sendMessage(
            sender,
            message['status'].content as unknown as AnyMessageContent,
            {
              backgroundColor: message['status'].option.backgroundColor,
              font: message['status'].option.font,
              statusJidList: batch,
              messageId: msgId,
            } as unknown as MiscMessageGenerationOptions,
          );

          return messageSent;
        }),
      );

      return firstMessage;
    }

    return await this.client.sendMessage(
      sender,
      message as unknown as AnyMessageContent,
      option as unknown as MiscMessageGenerationOptions,
    );
  }

  private async sendMessageWithTyping<T = proto.IMessage>(
    number: string,
    message: T,
    options?: Options,
    isIntegration = false,
  ) {
    const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

    if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
      throw new BadRequestException(isWA);
    }

    const sender = isWA.jid.toLowerCase();

    this.logger.verbose(`Sending message to ${sender}`);

    try {
      if (options?.delay) {
        this.logger.verbose(`Typing for ${options.delay}ms to ${sender}`);
        if (options.delay > 20000) {
          let remainingDelay = options.delay;
          while (remainingDelay > 20000) {
            await this.client.presenceSubscribe(sender);

            await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

            await delay(20000);

            await this.client.sendPresenceUpdate('paused', sender);

            remainingDelay -= 20000;
          }
          if (remainingDelay > 0) {
            await this.client.presenceSubscribe(sender);

            await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

            await delay(remainingDelay);

            await this.client.sendPresenceUpdate('paused', sender);
          }
        } else {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((options.presence as WAPresence) ?? 'composing', sender);

          await delay(options.delay);

          await this.client.sendPresenceUpdate('paused', sender);
        }
      }

      const linkPreview = options?.linkPreview != false ? undefined : false;

      let quoted: WAMessage;

      if (options?.quoted) {
        const m = options?.quoted;

        const msg = m?.message ? m : ((await this.getMessage(m.key, true)) as WAMessage);

        if (msg) {
          quoted = msg;
        }
      }

      let messageSent: WAMessage;

      let mentions: string[];
      let contextInfo: any;

      if (isJidGroup(sender)) {
        let group;
        try {
          const cache = this.configService.get<CacheConf>('CACHE');
          if (!cache.REDIS.ENABLED && !cache.LOCAL.ENABLED) group = await this.findGroup({ groupJid: sender }, 'inner');
          else group = await this.getGroupMetadataCache(sender);
          // group = await this.findGroup({ groupJid: sender }, 'inner');
        } catch {
          throw new NotFoundException('Group not found');
        }

        if (!group) {
          throw new NotFoundException('Group not found');
        }

        if (options?.mentionsEveryOne) {
          mentions = group.participants.map((participant) => participant.id);
        } else if (options?.mentioned?.length) {
          mentions = options.mentioned.map((mention) => {
            const jid = createJid(mention);
            if (isJidGroup(jid)) {
              return null;
            }
            return jid;
          });
        }

        messageSent = await this.sendMessage(
          sender,
          message,
          mentions,
          linkPreview,
          quoted,
          null,
          group?.ephemeralDuration,
          // group?.participants,
        );
      } else {
        contextInfo = {
          mentionedJid: [],
          groupMentions: [],
          //expiration: 7776000,
          ephemeralSettingTimestamp: {
            low: Math.floor(Date.now() / 1000) - 172800,
            high: 0,
            unsigned: false,
          },
          disappearingMode: { initiator: 0 },
        };
        messageSent = await this.sendMessage(
          sender,
          message,
          mentions,
          linkPreview,
          quoted,
          null,
          undefined,
          contextInfo,
        );
      }

      if (Long.isLong(messageSent?.messageTimestamp)) {
        messageSent.messageTimestamp = messageSent.messageTimestamp?.toNumber();
      }

      const messageRaw = this.prepareMessage(messageSent);

      const isMedia =
        messageSent?.message?.imageMessage ||
        messageSent?.message?.videoMessage ||
        messageSent?.message?.stickerMessage ||
        messageSent?.message?.ptvMessage ||
        messageSent?.message?.documentMessage ||
        messageSent?.message?.documentWithCaptionMessage ||
        messageSent?.message?.ptvMessage ||
        messageSent?.message?.audioMessage;

      const isVideo = messageSent?.message?.videoMessage;

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && !isIntegration) {
        this.chatwootService.eventWhatsapp(
          Events.SEND_MESSAGE,
          { instanceName: this.instance.name, instanceId: this.instanceId },
          messageRaw,
        );
      }

      if (this.configService.get<Openai>('OPENAI').ENABLED && messageRaw?.message?.audioMessage) {
        // ✅ FIX DB TIMEOUT: Query OpenAI settings con timeout
        const openAiDefaultSettings = await withDbTimeout(
          this.prismaRepository.openaiSetting.findFirst({
            where: { instanceId: this.instanceId },
            include: { OpenaiCreds: true },
          }),
          'sendDataWebhook:openAiSettings',
        );

        if (openAiDefaultSettings && openAiDefaultSettings.openaiCredsId && openAiDefaultSettings.speechToText) {
          messageRaw.message.speechToText = `[audio] ${await this.openaiService.speechToText(messageRaw, this)}`;
        }
      }

      if (this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE) {
        const msg = await withDbTimeout(
          this.prismaRepository.message.create({ data: messageRaw }),
          'sendDataWebhook:createMessage',
        );

        if (isMedia && this.configService.get<S3>('S3').ENABLE) {
          try {
            if (isVideo && !this.configService.get<S3>('S3').SAVE_VIDEO) {
              throw new Error('Video upload is disabled.');
            }

            const message: any = messageRaw;

            // Verificação adicional para garantir que há conteúdo de mídia real
            const hasRealMedia = this.hasValidMediaContent(message);

            if (!hasRealMedia) {
              this.logger.warn('Message detected as media but contains no valid media content');
            } else {
              const media = await this.getBase64FromMediaMessage({ message }, true);

              const { buffer, mediaType, fileName, size } = media;

              const mimetype = mimeTypes.lookup(fileName).toString();

              const fullName = join(
                `${this.instance.id}`,
                messageRaw.key.remoteJid,
                `${messageRaw.key.id}`,
                mediaType,
                fileName,
              );

              await s3Service.uploadFile(fullName, buffer, size.fileLength?.low, { 'Content-Type': mimetype });

              await withDbTimeout(
                this.prismaRepository.media.create({
                  data: {
                    messageId: msg.id,
                    instanceId: this.instanceId,
                    type: mediaType,
                    fileName: fullName,
                    mimetype,
                  },
                }),
                'sendDataWebhook:createMedia',
              );

              const mediaUrl = await s3Service.getObjectUrl(fullName);

              messageRaw.message.mediaUrl = mediaUrl;

              await withDbTimeout(
                this.prismaRepository.message.update({ where: { id: msg.id }, data: messageRaw }),
                'sendDataWebhook:updateMessageMedia',
              );
            }
          } catch (error) {
            this.logger.error(['Error on upload file to minio', error?.message, error?.stack]);
          }
        }
      }

      if (this.localWebhook.enabled) {
        if (isMedia && this.localWebhook.webhookBase64) {
          try {
            const buffer = await downloadMediaMessage(
              { key: messageRaw.key, message: messageRaw?.message },
              'buffer',
              {},
              { logger: P({ level: 'error' }) as any, reuploadRequest: this.client.updateMediaMessage },
            );

            if (buffer) {
              messageRaw.message.base64 = buffer.toString('base64');
            } else {
              // retry to download media
              const buffer = await downloadMediaMessage(
                { key: messageRaw.key, message: messageRaw?.message },
                'buffer',
                {},
                { logger: P({ level: 'error' }) as any, reuploadRequest: this.client.updateMediaMessage },
              );

              if (buffer) {
                messageRaw.message.base64 = buffer.toString('base64');
              }
            }
          } catch (error) {
            this.logger.error(['Error converting media to base64', error?.message]);
          }
        }
      }

      this.logger.verbose(messageSent);

      this.sendDataWebhook(Events.SEND_MESSAGE, messageRaw);

      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled && isIntegration) {
        await chatbotController.emit({
          instance: { instanceName: this.instance.name, instanceId: this.instanceId },
          remoteJid: messageRaw.key.remoteJid,
          msg: messageRaw,
          pushName: messageRaw.pushName,
          isIntegration,
        });
      }

      return messageRaw;
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Instance Controller
  public async sendPresence(data: SendPresenceDto) {
    try {
      const { number } = data;

      const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

      if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
        throw new BadRequestException(isWA);
      }

      const sender = isWA.jid;

      if (data?.delay && data?.delay > 20000) {
        let remainingDelay = data?.delay;
        while (remainingDelay > 20000) {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((data?.presence as WAPresence) ?? 'composing', sender);

          await delay(20000);

          await this.client.sendPresenceUpdate('paused', sender);

          remainingDelay -= 20000;
        }
        if (remainingDelay > 0) {
          await this.client.presenceSubscribe(sender);

          await this.client.sendPresenceUpdate((data?.presence as WAPresence) ?? 'composing', sender);

          await delay(remainingDelay);

          await this.client.sendPresenceUpdate('paused', sender);
        }
      } else {
        await this.client.presenceSubscribe(sender);

        await this.client.sendPresenceUpdate((data?.presence as WAPresence) ?? 'composing', sender);

        await delay(data?.delay);

        await this.client.sendPresenceUpdate('paused', sender);
      }

      return { presence: data.presence };
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Presence Controller
  public async setPresence(data: SetPresenceDto) {
    try {
      await this.client.sendPresenceUpdate(data.presence);

      return { presence: data.presence };
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  // Send Message Controller
  public async textMessage(data: SendTextDto, isIntegration = false) {
    const text = data.text;

    if (!text || text.trim().length === 0) {
      throw new BadRequestException('Text is required');
    }

    return await this.sendMessageWithTyping(
      data.number,
      { conversation: data.text },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );
  }

  public async pollMessage(data: SendPollDto) {
    return await this.sendMessageWithTyping(
      data.number,
      { poll: { name: data.name, selectableCount: data.selectableCount, values: data.values } },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        linkPreview: data?.linkPreview,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  private async formatStatusMessage(status: StatusMessage) {
    if (!status.type) {
      throw new BadRequestException('Type is required');
    }

    if (!status.content) {
      throw new BadRequestException('Content is required');
    }

    if (status.allContacts) {
      const contacts = await withDbTimeout(
        this.prismaRepository.contact.findMany({ where: { instanceId: this.instanceId } }),
        'sendStatus:findAllContacts',
      );

      if (!contacts.length) {
        throw new BadRequestException('Contacts not found');
      }

      status.statusJidList = contacts.filter((contact) => contact.pushName).map((contact) => contact.remoteJid);
    }

    if (!status.statusJidList?.length && !status.allContacts) {
      throw new BadRequestException('StatusJidList is required');
    }

    if (status.type === 'text') {
      if (!status.backgroundColor) {
        throw new BadRequestException('Background color is required');
      }

      if (!status.font) {
        throw new BadRequestException('Font is required');
      }

      return {
        content: { text: status.content },
        option: { backgroundColor: status.backgroundColor, font: status.font, statusJidList: status.statusJidList },
      };
    }
    if (status.type === 'image') {
      return {
        content: { image: { url: status.content }, caption: status.caption },
        option: { statusJidList: status.statusJidList },
      };
    }

    if (status.type === 'video') {
      return {
        content: { video: { url: status.content }, caption: status.caption },
        option: { statusJidList: status.statusJidList },
      };
    }

    if (status.type === 'audio') {
      const convert = await this.processAudioMp4(status.content);
      if (Buffer.isBuffer(convert)) {
        const result = {
          content: { audio: convert, ptt: true, mimetype: 'audio/ogg; codecs=opus' },
          option: { statusJidList: status.statusJidList },
        };

        return result;
      } else {
        throw new InternalServerErrorException(convert);
      }
    }

    throw new BadRequestException('Type not found');
  }

  public async statusMessage(data: SendStatusDto, file?: any) {
    const mediaData: SendStatusDto = { ...data };

    if (file) mediaData.content = file.buffer.toString('base64');

    const status = await this.formatStatusMessage(mediaData);

    const statusSent = await this.sendMessageWithTyping('status@broadcast', { status });

    return statusSent;
  }

  private async prepareMediaMessage(mediaMessage: MediaMessage) {
    try {
      const type = mediaMessage.mediatype === 'ptv' ? 'video' : mediaMessage.mediatype;

      let mediaInput: any;
      if (mediaMessage.mediatype === 'image') {
        let imageBuffer: Buffer;
        if (isURL(mediaMessage.media)) {
          let config: any = { responseType: 'arraybuffer' };

          if (this.localProxy?.enabled) {
            config = {
              ...config,
              httpsAgent: makeProxyAgent({
                host: this.localProxy.host,
                port: this.localProxy.port,
                protocol: this.localProxy.protocol,
                username: this.localProxy.username,
                password: this.localProxy.password,
              }),
            };
          }

          // ✅ FIX HTTP TIMEOUT: Media download con timeout 15s
          const response = await withHttpTimeout(axios.get(mediaMessage.media, config), 'mediaDownload:image');
          imageBuffer = Buffer.from(response.data, 'binary');
        } else {
          imageBuffer = Buffer.from(mediaMessage.media, 'base64');
        }

        mediaInput = await sharp(imageBuffer).jpeg().toBuffer();
        mediaMessage.fileName ??= 'image.jpg';
        mediaMessage.mimetype = 'image/jpeg';
      } else {
        mediaInput = isURL(mediaMessage.media)
          ? { url: mediaMessage.media }
          : Buffer.from(mediaMessage.media, 'base64');
      }

      const prepareMedia = await prepareWAMessageMedia(
        {
          [type]: mediaInput,
        } as any,
        { upload: this.client.waUploadToServer },
      );

      const mediaType = mediaMessage.mediatype + 'Message';

      if (mediaMessage.mediatype === 'document' && !mediaMessage.fileName) {
        const regex = new RegExp(/.*\/(.+?)\./);
        const arrayMatch = regex.exec(mediaMessage.media);
        mediaMessage.fileName = arrayMatch[1];
      }

      if (mediaMessage.mediatype === 'image' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'image.jpg';
      }

      if (mediaMessage.mediatype === 'video' && !mediaMessage.fileName) {
        mediaMessage.fileName = 'video.mp4';
      }

      let mimetype: string | false;

      if (mediaMessage.mimetype) {
        mimetype = mediaMessage.mimetype;
      } else {
        mimetype = mimeTypes.lookup(mediaMessage.fileName);

        if (!mimetype && isURL(mediaMessage.media)) {
          let config: any = { responseType: 'arraybuffer' };

          if (this.localProxy?.enabled) {
            config = {
              ...config,
              httpsAgent: makeProxyAgent({
                host: this.localProxy.host,
                port: this.localProxy.port,
                protocol: this.localProxy.protocol,
                username: this.localProxy.username,
                password: this.localProxy.password,
              }),
            };
          }

          // ✅ FIX HTTP TIMEOUT: Mimetype extraction con timeout 15s
          const response = await withHttpTimeout(axios.get(mediaMessage.media, config), 'mediaDownload:mimetype');

          mimetype = response.headers['content-type'];
        }
      }

      if (mediaMessage.mediatype === 'ptv') {
        prepareMedia[mediaType] = prepareMedia[type + 'Message'];
        mimetype = 'video/mp4';

        if (!prepareMedia[mediaType]) {
          throw new Error('Failed to prepare video message');
        }

        try {
          let mediaInput;
          if (isURL(mediaMessage.media)) {
            mediaInput = mediaMessage.media;
          } else {
            const mediaBuffer = Buffer.from(mediaMessage.media, 'base64');
            if (!mediaBuffer || mediaBuffer.length === 0) {
              throw new Error('Invalid media buffer');
            }
            mediaInput = mediaBuffer;
          }

          const duration = await getVideoDuration(mediaInput);
          if (!duration || duration <= 0) {
            throw new Error('Invalid media duration');
          }

          this.logger.verbose(`Video duration: ${duration} seconds`);
          prepareMedia[mediaType].seconds = duration;
        } catch (error) {
          this.logger.error('Error getting video duration:');
          this.logger.error(error);
          throw new Error(`Failed to get video duration: ${error.message}`);
        }
      }

      if (mediaMessage?.fileName) {
        mimetype = mimeTypes.lookup(mediaMessage.fileName).toString();
        if (mimetype === 'application/mp4') {
          mimetype = 'video/mp4';
        }
      }

      prepareMedia[mediaType].caption = mediaMessage?.caption;
      prepareMedia[mediaType].mimetype = mimetype;
      prepareMedia[mediaType].fileName = mediaMessage.fileName;

      if (mediaMessage.mediatype === 'video') {
        prepareMedia[mediaType].gifPlayback = false;
      }

      return generateWAMessageFromContent(
        '',
        { [mediaType]: { ...prepareMedia[mediaType] } },
        { userJid: this.instance.wuid },
      );
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(error?.toString() || error);
    }
  }

  private async convertToWebP(image: string): Promise<Buffer> {
    try {
      let imageBuffer: Buffer;

      if (isBase64(image)) {
        const base64Data = image.replace(/^data:image\/(jpeg|png|gif);base64,/, '');
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        const timestamp = new Date().getTime();
        const parsedURL = new URL(image);
        parsedURL.searchParams.set('timestamp', timestamp.toString());
        const url = parsedURL.toString();

        let config: any = { responseType: 'arraybuffer' };

        if (this.localProxy?.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent({
              host: this.localProxy.host,
              port: this.localProxy.port,
              protocol: this.localProxy.protocol,
              username: this.localProxy.username,
              password: this.localProxy.password,
            }),
          };
        }

        // ✅ FIX HTTP TIMEOUT: Sticker image download con timeout 15s
        const response = await withHttpTimeout(axios.get(url, config), 'stickerDownload');
        imageBuffer = Buffer.from(response.data, 'binary');
      }

      const isAnimated = this.isAnimated(image, imageBuffer);

      if (isAnimated) {
        return await sharp(imageBuffer, { animated: true }).webp({ quality: 80 }).toBuffer();
      } else {
        return await sharp(imageBuffer).webp().toBuffer();
      }
    } catch (error) {
      console.error('Erro ao converter a imagem para WebP:', error);
      throw error;
    }
  }

  private isAnimatedWebp(buffer: Buffer): boolean {
    if (buffer.length < 12) return false;

    return buffer.indexOf(Buffer.from('ANIM')) !== -1;
  }

  private isAnimated(image: string, buffer: Buffer): boolean {
    const lowerCaseImage = image.toLowerCase();

    if (lowerCaseImage.includes('.gif')) return true;

    if (lowerCaseImage.includes('.webp')) return this.isAnimatedWebp(buffer);

    return false;
  }

  public async mediaSticker(data: SendStickerDto, file?: any) {
    const mediaData: SendStickerDto = { ...data };

    if (file) mediaData.sticker = file.buffer.toString('base64');

    const convert = data?.notConvertSticker
      ? Buffer.from(data.sticker, 'base64')
      : await this.convertToWebP(data.sticker);
    const gifPlayback = data.sticker.includes('.gif');
    const result = await this.sendMessageWithTyping(
      data.number,
      { sticker: convert, gifPlayback },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );

    return result;
  }

  public async mediaMessage(data: SendMediaDto, file?: any, isIntegration = false) {
    const mediaData: SendMediaDto = { ...data };

    if (file) mediaData.media = file.buffer.toString('base64');

    const generate = await this.prepareMediaMessage(mediaData);

    const mediaSent = await this.sendMessageWithTyping(
      data.number,
      { ...generate.message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );

    return mediaSent;
  }

  public async ptvMessage(data: SendPtvDto, file?: any, isIntegration = false) {
    const mediaData: SendMediaDto = {
      number: data.number,
      media: data.video,
      mediatype: 'ptv',
      delay: data?.delay,
      quoted: data?.quoted,
      mentionsEveryOne: data?.mentionsEveryOne,
      mentioned: data?.mentioned,
    };

    if (file) mediaData.media = file.buffer.toString('base64');

    const generate = await this.prepareMediaMessage(mediaData);

    const mediaSent = await this.sendMessageWithTyping(
      data.number,
      { ...generate.message },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
      isIntegration,
    );

    return mediaSent;
  }

  public async processAudioMp4(audio: string) {
    let inputStream: PassThrough;

    if (isURL(audio)) {
      // ✅ FIX HTTP TIMEOUT: Audio download stream con timeout 15s
      const response = await withHttpTimeout(axios.get(audio, { responseType: 'stream' }), 'audioDownload:mp4');
      inputStream = response.data;
    } else {
      const audioBuffer = Buffer.from(audio, 'base64');
      inputStream = new PassThrough();
      inputStream.end(audioBuffer);
    }

    return new Promise<Buffer>((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegPath.path, [
        '-i',
        'pipe:0',
        '-vn',
        '-ab',
        '128k',
        '-ar',
        '44100',
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe+empty_moov',
        'pipe:1',
      ]);

      // ✅ FIX 6: Registra FFmpeg nel ResourceRegistry per tracking e cleanup
      this.resourceRegistry.addProcess(ffmpegProcess, 'ffmpeg-audio-conversion');

      const outputChunks: Buffer[] = [];
      let stderrData = '';

      ffmpegProcess.stdout.on('data', (chunk) => {
        outputChunks.push(chunk);
      });

      ffmpegProcess.stderr.on('data', (data) => {
        stderrData += data.toString();
        this.logger.verbose(`ffmpeg stderr: ${data}`);
      });

      ffmpegProcess.on('error', (error) => {
        // ✅ FIX 6: Rimuovi processo dal registry in caso di errore
        this.resourceRegistry.removeProcess(ffmpegProcess);
        console.error('Error in ffmpeg process', error);
        reject(error);
      });

      ffmpegProcess.on('close', (code) => {
        // ✅ FIX 6: Rimuovi processo dal registry quando termina
        this.resourceRegistry.removeProcess(ffmpegProcess);
        if (code === 0) {
          this.logger.verbose('Audio converted to mp4');
          const outputBuffer = Buffer.concat(outputChunks);
          resolve(outputBuffer);
        } else {
          this.logger.error(`ffmpeg exited with code ${code}`);
          this.logger.error(`ffmpeg stderr: ${stderrData}`);
          reject(new Error(`ffmpeg exited with code ${code}: ${stderrData}`));
        }
      });

      inputStream.pipe(ffmpegProcess.stdin);

      inputStream.on('error', (err) => {
        console.error('Error in inputStream', err);
        ffmpegProcess.stdin.end();
        reject(err);
      });
    });
  }

  public async processAudio(audio: string): Promise<Buffer> {
    const audioConverterConfig = this.configService.get<AudioConverter>('AUDIO_CONVERTER');
    if (audioConverterConfig.API_URL) {
      this.logger.verbose('Using audio converter API');
      const formData = new FormData();

      if (isURL(audio)) {
        formData.append('url', audio);
      } else {
        formData.append('base64', audio);
      }

      // ✅ FIX HTTP TIMEOUT: Audio converter API con timeout 30s (operazione lenta)
      const { data } = await withHttpTimeout(
        axios.post(audioConverterConfig.API_URL, formData, {
          headers: { ...formData.getHeaders(), apikey: audioConverterConfig.API_KEY },
        }),
        'audioConverter:API',
      );

      if (!data.audio) {
        throw new InternalServerErrorException('Failed to convert audio');
      }

      this.logger.verbose('Audio converted');
      return Buffer.from(data.audio, 'base64');
    } else {
      let inputAudioStream: PassThrough;

      if (isURL(audio)) {
        const timestamp = new Date().getTime();
        const parsedURL = new URL(audio);
        parsedURL.searchParams.set('timestamp', timestamp.toString());
        const url = parsedURL.toString();

        const config: any = { responseType: 'stream' };

        // ✅ FIX HTTP TIMEOUT: Audio stream download con timeout 15s
        const response = await withHttpTimeout(axios.get(url, config), 'audioDownload:stream');
        inputAudioStream = response.data.pipe(new PassThrough());
      } else {
        const audioBuffer = Buffer.from(audio, 'base64');
        inputAudioStream = new PassThrough();
        inputAudioStream.end(audioBuffer);
      }

      const isLpcm = isURL(audio) && /\.lpcm($|\?)/i.test(audio);

      return new Promise((resolve, reject) => {
        const outputAudioStream = new PassThrough();
        const chunks: Buffer[] = [];

        outputAudioStream.on('data', (chunk) => chunks.push(chunk));
        outputAudioStream.on('end', () => {
          const outputBuffer = Buffer.concat(chunks);
          resolve(outputBuffer);
        });

        outputAudioStream.on('error', (error) => {
          console.log('error', error);
          reject(error);
        });

        ffmpeg.setFfmpegPath(ffmpegPath.path);

        let command = ffmpeg(inputAudioStream);

        if (isLpcm) {
          this.logger.verbose('Detected LPCM input – applying raw PCM settings');
          command = command.inputFormat('s16le').inputOptions(['-ar', '24000', '-ac', '1']);
        }

        command
          .outputFormat('ogg')
          .noVideo()
          .audioCodec('libopus')
          .addOutputOptions('-avoid_negative_ts make_zero')
          .audioBitrate('128k')
          .audioFrequency(48000)
          .audioChannels(1)
          .outputOptions([
            '-write_xing',
            '0',
            '-compression_level',
            '10',
            '-application',
            'voip',
            '-fflags',
            '+bitexact',
            '-flags',
            '+bitexact',
            '-id3v2_version',
            '0',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-write_bext',
            '0',
          ])
          .pipe(outputAudioStream, { end: true })
          .on('error', function (error) {
            console.log('error', error);
            reject(error);
          });
      });
    }
  }

  public async audioWhatsapp(data: SendAudioDto, file?: any, isIntegration = false) {
    const mediaData: SendAudioDto = { ...data };

    if (file?.buffer) {
      mediaData.audio = file.buffer.toString('base64');
    } else if (!isURL(data.audio) && !isBase64(data.audio)) {
      console.error('Invalid file or audio source');
      throw new BadRequestException('File buffer, URL, or base64 audio is required');
    }

    if (!data?.encoding && data?.encoding !== false) {
      data.encoding = true;
    }

    if (data?.encoding) {
      const convert = await this.processAudio(mediaData.audio);

      if (Buffer.isBuffer(convert)) {
        const result = this.sendMessageWithTyping<AnyMessageContent>(
          data.number,
          { audio: convert, ptt: true, mimetype: 'audio/ogg; codecs=opus' },
          { presence: 'recording', delay: data?.delay },
          isIntegration,
        );

        return result;
      } else {
        throw new InternalServerErrorException('Failed to convert audio');
      }
    }

    return await this.sendMessageWithTyping<AnyMessageContent>(
      data.number,
      {
        audio: isURL(data.audio) ? { url: data.audio } : Buffer.from(data.audio, 'base64'),
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      },
      { presence: 'recording', delay: data?.delay },
      isIntegration,
    );
  }

  private generateRandomId(length = 11) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  private toJSONString(button: Button): string {
    const toString = (obj: any) => JSON.stringify(obj);

    const json = {
      call: () => toString({ display_text: button.displayText, phone_number: button.phoneNumber }),
      reply: () => toString({ display_text: button.displayText, id: button.id }),
      copy: () => toString({ display_text: button.displayText, copy_code: button.copyCode }),
      url: () => toString({ display_text: button.displayText, url: button.url, merchant_url: button.url }),
      pix: () =>
        toString({
          currency: button.currency,
          total_amount: { value: 0, offset: 100 },
          reference_id: this.generateRandomId(),
          type: 'physical-goods',
          order: {
            status: 'pending',
            subtotal: { value: 0, offset: 100 },
            order_type: 'ORDER',
            items: [
              { name: '', amount: { value: 0, offset: 100 }, quantity: 0, sale_amount: { value: 0, offset: 100 } },
            ],
          },
          payment_settings: [
            {
              type: 'pix_static_code',
              pix_static_code: {
                merchant_name: button.name,
                key: button.key,
                key_type: this.mapKeyType.get(button.keyType),
              },
            },
          ],
          share_payment_status: false,
        }),
    };

    return json[button.type]?.() || '';
  }

  private readonly mapType = new Map<TypeButton, string>([
    ['reply', 'quick_reply'],
    ['copy', 'cta_copy'],
    ['url', 'cta_url'],
    ['call', 'cta_call'],
    ['pix', 'payment_info'],
  ]);

  private readonly mapKeyType = new Map<KeyType, string>([
    ['phone', 'PHONE'],
    ['email', 'EMAIL'],
    ['cpf', 'CPF'],
    ['cnpj', 'CNPJ'],
    ['random', 'EVP'],
  ]);

  public async buttonMessage(data: SendButtonsDto) {
    if (data.buttons.length === 0) {
      throw new BadRequestException('At least one button is required');
    }

    const hasReplyButtons = data.buttons.some((btn) => btn.type === 'reply');

    const hasPixButton = data.buttons.some((btn) => btn.type === 'pix');

    const hasOtherButtons = data.buttons.some((btn) => btn.type !== 'reply' && btn.type !== 'pix');

    if (hasReplyButtons) {
      if (data.buttons.length > 3) {
        throw new BadRequestException('Maximum of 3 reply buttons allowed');
      }
      if (hasOtherButtons) {
        throw new BadRequestException('Reply buttons cannot be mixed with other button types');
      }
    }

    if (hasPixButton) {
      if (data.buttons.length > 1) {
        throw new BadRequestException('Only one PIX button is allowed');
      }
      if (hasOtherButtons) {
        throw new BadRequestException('PIX button cannot be mixed with other button types');
      }

      const message: proto.IMessage = {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              nativeFlowMessage: {
                buttons: [{ name: this.mapType.get('pix'), buttonParamsJson: this.toJSONString(data.buttons[0]) }],
                messageParamsJson: JSON.stringify({ from: 'api', templateId: v4() }),
              },
            },
          },
        },
      };

      return await this.sendMessageWithTyping(data.number, message, {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      });
    }

    const generate = await (async () => {
      if (data?.thumbnailUrl) {
        return await this.prepareMediaMessage({ mediatype: 'image', media: data.thumbnailUrl });
      }
    })();

    const buttons = data.buttons.map((value) => {
      return { name: this.mapType.get(value.type), buttonParamsJson: this.toJSONString(value) };
    });

    const message: proto.IMessage = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: {
              text: (() => {
                let t = '*' + data.title + '*';
                if (data?.description) {
                  t += '\n\n';
                  t += data.description;
                  t += '\n';
                }
                return t;
              })(),
            },
            footer: { text: data?.footer },
            header: (() => {
              if (generate?.message?.imageMessage) {
                return {
                  hasMediaAttachment: !!generate.message.imageMessage,
                  imageMessage: generate.message.imageMessage,
                };
              }
            })(),
            nativeFlowMessage: {
              buttons: buttons,
              messageParamsJson: JSON.stringify({ from: 'api', templateId: v4() }),
            },
          },
        },
      },
    };

    return await this.sendMessageWithTyping(data.number, message, {
      delay: data?.delay,
      presence: 'composing',
      quoted: data?.quoted,
      mentionsEveryOne: data?.mentionsEveryOne,
      mentioned: data?.mentioned,
    });
  }

  public async locationMessage(data: SendLocationDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        locationMessage: {
          degreesLatitude: data.latitude,
          degreesLongitude: data.longitude,
          name: data?.name,
          address: data?.address,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  public async listMessage(data: SendListDto) {
    return await this.sendMessageWithTyping(
      data.number,
      {
        listMessage: {
          title: data.title,
          description: data.description,
          buttonText: data?.buttonText,
          footerText: data?.footerText,
          sections: data.sections,
          listType: 2,
        },
      },
      {
        delay: data?.delay,
        presence: 'composing',
        quoted: data?.quoted,
        mentionsEveryOne: data?.mentionsEveryOne,
        mentioned: data?.mentioned,
      },
    );
  }

  public async contactMessage(data: SendContactDto) {
    const message: proto.IMessage = {};

    const vcard = (contact: ContactMessage) => {
      let result = 'BEGIN:VCARD\n' + 'VERSION:3.0\n' + `N:${contact.fullName}\n` + `FN:${contact.fullName}\n`;

      if (contact.organization) {
        result += `ORG:${contact.organization};\n`;
      }

      if (contact.email) {
        result += `EMAIL:${contact.email}\n`;
      }

      if (contact.url) {
        result += `URL:${contact.url}\n`;
      }

      if (!contact.wuid) {
        contact.wuid = createJid(contact.phoneNumber);
      }

      result += `item1.TEL;waid=${contact.wuid}:${contact.phoneNumber}\n` + 'item1.X-ABLabel:Celular\n' + 'END:VCARD';

      return result;
    };

    if (data.contact.length === 1) {
      message.contactMessage = { displayName: data.contact[0].fullName, vcard: vcard(data.contact[0]) };
    } else {
      message.contactsArrayMessage = {
        displayName: `${data.contact.length} contacts`,
        contacts: data.contact.map((contact) => {
          return { displayName: contact.fullName, vcard: vcard(contact) };
        }),
      };
    }

    return await this.sendMessageWithTyping(data.number, { ...message }, {});
  }

  public async reactionMessage(data: SendReactionDto) {
    return await this.sendMessageWithTyping(data.key.remoteJid, {
      reactionMessage: { key: data.key, text: data.reaction },
    });
  }

  // Chat Controller
  public async whatsappNumber(data: WhatsAppNumberDto) {
    const jids: {
      groups: { number: string; jid: string }[];
      broadcast: { number: string; jid: string }[];
      users: { number: string; jid: string; name?: string }[];
    } = { groups: [], broadcast: [], users: [] };

    data.numbers.forEach((number) => {
      const jid = createJid(number);

      if (isJidGroup(jid)) {
        jids.groups.push({ number, jid });
      } else if (jid === 'status@broadcast') {
        jids.broadcast.push({ number, jid });
      } else {
        jids.users.push({ number, jid });
      }
    });

    const onWhatsapp: OnWhatsAppDto[] = [];

    // BROADCAST
    onWhatsapp.push(...jids.broadcast.map(({ jid, number }) => new OnWhatsAppDto(jid, false, number)));

    // GROUPS
    const groups = await Promise.all(
      jids.groups.map(async ({ jid, number }) => {
        const group = await this.findGroup({ groupJid: jid }, 'inner');

        if (!group) {
          return new OnWhatsAppDto(jid, false, number);
        }

        return new OnWhatsAppDto(group.id, true, number, group?.subject);
      }),
    );
    onWhatsapp.push(...groups);

    // USERS
    const contacts: any[] = await withDbTimeout(
      this.prismaRepository.contact.findMany({
        where: { instanceId: this.instanceId, remoteJid: { in: jids.users.map(({ jid }) => jid) } },
      }),
      'whatsappNumber:findContacts',
    );

    // Unified cache verification for all numbers (normal and LID)
    const numbersToVerify = jids.users.map(({ jid }) => jid.replace('+', ''));

    // Get all numbers from cache
    const cachedNumbers = await getOnWhatsappCache(numbersToVerify);

    // Separate numbers that are and are not in cache
    const cachedJids = new Set(cachedNumbers.flatMap((cached) => cached.jidOptions));
    const numbersNotInCache = numbersToVerify.filter((jid) => !cachedJids.has(jid));

    // Only call Baileys for normal numbers (@s.whatsapp.net) that are not in cache
    let verify: { jid: string; exists: boolean }[] = [];
    const normalNumbersNotInCache = numbersNotInCache.filter((jid) => !jid.includes('@lid'));

    if (normalNumbersNotInCache.length > 0) {
      this.logger.verbose(`Checking ${normalNumbersNotInCache.length} numbers via Baileys (not found in cache)`);
      verify = await this.client.onWhatsApp(...normalNumbersNotInCache);
    }

    const verifiedUsers = await Promise.all(
      jids.users.map(async (user) => {
        // Try to get from cache first (works for all: normal and LID)
        const cached = cachedNumbers.find((cached) => cached.jidOptions.includes(user.jid.replace('+', '')));

        if (cached) {
          this.logger.verbose(`Number ${user.number} found in cache`);
          return new OnWhatsAppDto(
            cached.remoteJid,
            true,
            user.number,
            contacts.find((c) => c.remoteJid === cached.remoteJid)?.pushName,
            cached.lid || (cached.remoteJid.includes('@lid') ? 'lid' : undefined),
          );
        }

        // If it's a LID number and not in cache, consider it valid
        if (user.jid.includes('@lid')) {
          return new OnWhatsAppDto(
            user.jid,
            true,
            user.number,
            contacts.find((c) => c.remoteJid === user.jid)?.pushName,
            'lid',
          );
        }

        // If not in cache and is a normal number, use Baileys verification
        let numberVerified: (typeof verify)[0] | null = null;

        // Brazilian numbers
        if (user.number.startsWith('55')) {
          const numberWithDigit =
            user.number.slice(4, 5) === '9' && user.number.length === 13
              ? user.number
              : `${user.number.slice(0, 4)}9${user.number.slice(4)}`;
          const numberWithoutDigit =
            user.number.length === 12 ? user.number : user.number.slice(0, 4) + user.number.slice(5);

          numberVerified = verify.find(
            (v) => v.jid === `${numberWithDigit}@s.whatsapp.net` || v.jid === `${numberWithoutDigit}@s.whatsapp.net`,
          );
        }

        // Mexican/Argentina numbers
        // Ref: https://faq.whatsapp.com/1294841057948784
        if (!numberVerified && (user.number.startsWith('52') || user.number.startsWith('54'))) {
          let prefix = '';
          if (user.number.startsWith('52')) {
            prefix = '1';
          }
          if (user.number.startsWith('54')) {
            prefix = '9';
          }

          const numberWithDigit =
            user.number.slice(2, 3) === prefix && user.number.length === 13
              ? user.number
              : `${user.number.slice(0, 2)}${prefix}${user.number.slice(2)}`;
          const numberWithoutDigit =
            user.number.length === 12 ? user.number : user.number.slice(0, 2) + user.number.slice(3);

          numberVerified = verify.find(
            (v) => v.jid === `${numberWithDigit}@s.whatsapp.net` || v.jid === `${numberWithoutDigit}@s.whatsapp.net`,
          );
        }

        if (!numberVerified) {
          numberVerified = verify.find((v) => v.jid === user.jid);
        }

        const numberJid = numberVerified?.jid || user.jid;

        return new OnWhatsAppDto(
          numberJid,
          !!numberVerified?.exists,
          user.number,
          contacts.find((c) => c.remoteJid === numberJid)?.pushName,
          undefined,
        );
      }),
    );

    // Combine results
    onWhatsapp.push(...verifiedUsers);

    // TODO: Salvar no cache apenas números que NÃO estavam no cache
    const numbersToCache = onWhatsapp.filter((user) => {
      if (!user.exists) return false;
      // Verifica se estava no cache usando jidOptions
      const cached = cachedNumbers?.find((cached) => cached.jidOptions.includes(user.jid.replace('+', '')));
      return !cached;
    });

    if (numbersToCache.length > 0) {
      this.logger.verbose(`Salvando ${numbersToCache.length} números no cache`);
      await saveOnWhatsappCache(
        numbersToCache.map((user) => ({
          remoteJid: user.jid,
          lid: user.lid === 'lid' ? 'lid' : undefined,
        })),
      );
    }

    return onWhatsapp;
  }

  public async markMessageAsRead(data: ReadMessageDto) {
    try {
      const keys: proto.IMessageKey[] = [];
      data.readMessages.forEach((read) => {
        if (isJidGroup(read.remoteJid) || isPnUser(read.remoteJid)) {
          keys.push({ remoteJid: read.remoteJid, fromMe: read.fromMe, id: read.id });
        }
      });
      await this.client.readMessages(keys);
      return { message: 'Read messages', read: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Read messages fail', error.toString());
    }
  }

  public async getLastMessage(number: string) {
    const where: any = { key: { remoteJid: number }, instanceId: this.instance.id };

    const messages = await withDbTimeout(
      this.prismaRepository.message.findMany({
        where,
        orderBy: { messageTimestamp: 'desc' },
        take: 1,
      }),
      'getLastMessage:findMessages',
    );

    if (messages.length === 0) {
      throw new NotFoundException('Messages not found');
    }

    let lastMessage = messages.pop();

    for (const message of messages) {
      if (message.messageTimestamp >= lastMessage.messageTimestamp) {
        lastMessage = message;
      }
    }

    return lastMessage as unknown as LastMessage;
  }

  public async archiveChat(data: ArchiveChatDto) {
    try {
      let last_message = data.lastMessage;
      let number = data.chat;

      if (!last_message && number) {
        last_message = await this.getLastMessage(number);
      } else {
        last_message = data.lastMessage;
        last_message.messageTimestamp = last_message?.messageTimestamp ?? Date.now();
        number = last_message?.key?.remoteJid;
      }

      if (!last_message || Object.keys(last_message).length === 0) {
        throw new NotFoundException('Last message not found');
      }

      await this.client.chatModify({ archive: data.archive, lastMessages: [last_message] }, createJid(number));

      return { chatId: number, archived: true };
    } catch (error) {
      throw new InternalServerErrorException({
        archived: false,
        message: ['An error occurred while archiving the chat. Open a calling.', error.toString()],
      });
    }
  }

  public async markChatUnread(data: MarkChatUnreadDto) {
    try {
      let last_message = data.lastMessage;
      let number = data.chat;

      if (!last_message && number) {
        last_message = await this.getLastMessage(number);
      } else {
        last_message = data.lastMessage;
        last_message.messageTimestamp = last_message?.messageTimestamp ?? Date.now();
        number = last_message?.key?.remoteJid;
      }

      if (!last_message || Object.keys(last_message).length === 0) {
        throw new NotFoundException('Last message not found');
      }

      await this.client.chatModify({ markRead: false, lastMessages: [last_message] }, createJid(number));

      return { chatId: number, markedChatUnread: true };
    } catch (error) {
      throw new InternalServerErrorException({
        markedChatUnread: false,
        message: ['An error occurred while marked unread the chat. Open a calling.', error.toString()],
      });
    }
  }

  public async deleteMessage(del: DeleteMessage) {
    try {
      const response = await this.client.sendMessage(del.remoteJid, { delete: del });
      if (response) {
        const messageId = response.message?.protocolMessage?.key?.id;
        if (messageId) {
          const isLogicalDeleted = configService.get<Database>('DATABASE').DELETE_DATA.LOGICAL_MESSAGE_DELETE;
          let message = await withDbTimeout(
            this.prismaRepository.message.findFirst({
              where: { key: { path: ['id'], equals: messageId } },
            }),
            'deleteMessage:findMessage',
          );
          if (isLogicalDeleted) {
            if (!message) return response;
            const existingKey = typeof message?.key === 'object' && message.key !== null ? message.key : {};
            message = await withDbTimeout(
              this.prismaRepository.message.update({
                where: { id: message.id },
                data: { key: { ...existingKey, deleted: true }, status: 'DELETED' },
              }),
              'deleteMessage:updateMessage',
            );
            if (this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE) {
              const messageUpdate: any = {
                messageId: message.id,
                keyId: messageId,
                remoteJid: response.key.remoteJid,
                fromMe: response.key.fromMe,
                participant: response.key?.participant,
                status: 'DELETED',
                instanceId: this.instanceId,
              };
              await withDbTimeout(
                this.prismaRepository.messageUpdate.create({ data: messageUpdate }),
                'deleteMessage:createMessageUpdate',
              );
            }
          } else {
            if (!message) return response;
            await withDbTimeout(
              this.prismaRepository.message.deleteMany({ where: { id: message.id } }),
              'deleteMessage:deleteMessage',
            );
          }
          this.sendDataWebhook(Events.MESSAGES_DELETE, {
            id: message.id,
            instanceId: message.instanceId,
            key: message.key,
            messageType: message.messageType,
            status: 'DELETED',
            source: message.source,
            messageTimestamp: message.messageTimestamp,
            pushName: message.pushName,
            participant: message.participant,
            message: message.message,
          });
        }
      }

      return response;
    } catch (error) {
      throw new InternalServerErrorException('Error while deleting message for everyone', error?.toString());
    }
  }

  public async mapMediaType(mediaType) {
    const map = {
      imageMessage: 'image',
      videoMessage: 'video',
      documentMessage: 'document',
      stickerMessage: 'sticker',
      audioMessage: 'audio',
      ptvMessage: 'video',
    };
    return map[mediaType] || null;
  }

  public async getBase64FromMediaMessage(data: getBase64FromMediaMessageDto, getBuffer = false) {
    try {
      const m = data?.message;
      const convertToMp4 = data?.convertToMp4 ?? false;

      const msg = m?.message ? m : ((await this.getMessage(m.key, true)) as proto.IWebMessageInfo);

      if (!msg) {
        throw 'Message not found';
      }

      for (const subtype of MessageSubtype) {
        if (msg.message[subtype]) {
          msg.message = msg.message[subtype].message;
        }
      }

      if ('messageContextInfo' in msg.message && Object.keys(msg.message).length === 1) {
        throw 'The message is messageContextInfo';
      }

      let mediaMessage: any;
      let mediaType: string;

      if (msg.message?.templateMessage) {
        const template =
          msg.message.templateMessage.hydratedTemplate || msg.message.templateMessage.hydratedFourRowTemplate;

        for (const type of TypeMediaMessage) {
          if (template[type]) {
            mediaMessage = template[type];
            mediaType = type;
            msg.message = { [type]: { ...template[type], url: template[type].staticUrl } };
            break;
          }
        }

        if (!mediaMessage) {
          throw 'Template message does not contain a supported media type';
        }
      } else {
        for (const type of TypeMediaMessage) {
          mediaMessage = msg.message[type];
          if (mediaMessage) {
            mediaType = type;
            break;
          }
        }

        if (!mediaMessage) {
          throw 'The message is not of the media type';
        }
      }

      if (typeof mediaMessage['mediaKey'] === 'object') {
        msg.message[mediaType].mediaKey = Uint8Array.from(Object.values(mediaMessage['mediaKey']));
      }

      let buffer: Buffer;

      try {
        buffer = await downloadMediaMessage(
          { key: msg?.key, message: msg?.message },
          'buffer',
          {},
          { logger: P({ level: 'error' }) as any, reuploadRequest: this.client.updateMediaMessage },
        );
      } catch {
        this.logger.error('Download Media failed, trying to retry in 5 seconds...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const mediaType = Object.keys(msg.message).find((key) => key.endsWith('Message'));
        if (!mediaType) throw new Error('Could not determine mediaType for fallback');

        try {
          const media = await downloadContentFromMessage(
            {
              mediaKey: msg.message?.[mediaType]?.mediaKey,
              directPath: msg.message?.[mediaType]?.directPath,
              url: `https://mmg.whatsapp.net${msg?.message?.[mediaType]?.directPath}`,
            },
            await this.mapMediaType(mediaType),
            {},
          );
          const chunks = [];
          for await (const chunk of media) {
            chunks.push(chunk);
          }
          buffer = Buffer.concat(chunks);
          this.logger.info('Download Media with downloadContentFromMessage was successful!');
        } catch (fallbackErr) {
          this.logger.error('Download Media with downloadContentFromMessage also failed!');
          throw fallbackErr;
        }
      }
      const typeMessage = getContentType(msg.message);

      const ext = mimeTypes.extension(mediaMessage?.['mimetype']);
      const fileName = mediaMessage?.['fileName'] || `${msg.key.id}.${ext}` || `${v4()}.${ext}`;

      if (convertToMp4 && typeMessage === 'audioMessage') {
        try {
          const convert = await this.processAudioMp4(buffer.toString('base64'));

          if (Buffer.isBuffer(convert)) {
            const result = {
              mediaType,
              fileName,
              caption: mediaMessage['caption'],
              size: {
                fileLength: mediaMessage['fileLength'],
                height: mediaMessage['height'],
                width: mediaMessage['width'],
              },
              mimetype: 'audio/mp4',
              base64: convert.toString('base64'),
              buffer: getBuffer ? convert : null,
            };

            return result;
          }
        } catch (error) {
          this.logger.error('Error converting audio to mp4:');
          this.logger.error(error);
          throw new BadRequestException('Failed to convert audio to MP4');
        }
      }

      return {
        mediaType,
        fileName,
        caption: mediaMessage['caption'],
        size: { fileLength: mediaMessage['fileLength'], height: mediaMessage['height'], width: mediaMessage['width'] },
        mimetype: mediaMessage['mimetype'],
        base64: buffer.toString('base64'),
        buffer: getBuffer ? buffer : null,
      };
    } catch (error) {
      this.logger.error('Error processing media message:');
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async fetchPrivacySettings() {
    const privacy = await this.client.fetchPrivacySettings();

    return {
      readreceipts: privacy.readreceipts,
      profile: privacy.profile,
      status: privacy.status,
      online: privacy.online,
      last: privacy.last,
      groupadd: privacy.groupadd,
    };
  }

  public async updatePrivacySettings(settings: PrivacySettingDto) {
    try {
      await this.client.updateReadReceiptsPrivacy(settings.readreceipts);
      await this.client.updateProfilePicturePrivacy(settings.profile);
      await this.client.updateStatusPrivacy(settings.status);
      await this.client.updateOnlinePrivacy(settings.online);
      await this.client.updateLastSeenPrivacy(settings.last);
      await this.client.updateGroupsAddPrivacy(settings.groupadd);

      this.reloadConnection();

      return {
        update: 'success',
        data: {
          readreceipts: settings.readreceipts,
          profile: settings.profile,
          status: settings.status,
          online: settings.online,
          last: settings.last,
          groupadd: settings.groupadd,
        },
      };
    } catch (error) {
      throw new InternalServerErrorException('Error updating privacy settings', error.toString());
    }
  }

  public async fetchBusinessProfile(number: string): Promise<NumberBusiness> {
    try {
      const jid = number ? createJid(number) : this.instance.wuid;

      const profile = await this.client.getBusinessProfile(jid);

      if (!profile) {
        const info = await this.whatsappNumber({ numbers: [jid] });

        return { isBusiness: false, message: 'Not is business profile', ...info?.shift() };
      }

      return { isBusiness: true, ...profile };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile name', error.toString());
    }
  }

  public async updateProfileName(name: string) {
    try {
      await this.client.updateProfileName(name);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile name', error.toString());
    }
  }

  public async updateProfileStatus(status: string) {
    try {
      await this.client.updateProfileStatus(status);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile status', error.toString());
    }
  }

  public async updateProfilePicture(picture: string) {
    try {
      let pic: WAMediaUpload;
      if (isURL(picture)) {
        const timestamp = new Date().getTime();
        const parsedURL = new URL(picture);
        parsedURL.searchParams.set('timestamp', timestamp.toString());
        const url = parsedURL.toString();

        let config: any = { responseType: 'arraybuffer' };

        if (this.localProxy?.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent({
              host: this.localProxy.host,
              port: this.localProxy.port,
              protocol: this.localProxy.protocol,
              username: this.localProxy.username,
              password: this.localProxy.password,
            }),
          };
        }

        // ✅ FIX HTTP TIMEOUT: User profile picture download con timeout 15s
        pic = (await withHttpTimeout(axios.get(url, config), 'profilePicDownload:user')).data;
      } else if (isBase64(picture)) {
        pic = Buffer.from(picture, 'base64');
      } else {
        throw new BadRequestException('"profilePicture" must be a url or a base64');
      }

      await this.client.updateProfilePicture(this.instance.wuid, pic);

      this.reloadConnection();

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating profile picture', error.toString());
    }
  }

  public async removeProfilePicture() {
    try {
      await this.client.removeProfilePicture(this.instance.wuid);

      this.reloadConnection();

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error removing profile picture', error.toString());
    }
  }

  public async blockUser(data: BlockUserDto) {
    try {
      const { number } = data;

      const isWA = (await this.whatsappNumber({ numbers: [number] }))?.shift();

      if (!isWA.exists && !isJidGroup(isWA.jid) && !isWA.jid.includes('@broadcast')) {
        throw new BadRequestException(isWA);
      }

      const sender = isWA.jid;

      await this.client.updateBlockStatus(sender, data.status);

      return { block: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error blocking user', error.toString());
    }
  }

  private async formatUpdateMessage(data: UpdateMessageDto) {
    try {
      if (!this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE) {
        return data;
      }

      const msg: any = await this.getMessage(data.key, true);

      if (msg?.messageType === 'conversation' || msg?.messageType === 'extendedTextMessage') {
        return { text: data.text };
      }

      if (msg?.messageType === 'imageMessage') {
        return { image: msg?.message?.imageMessage, caption: data.text };
      }

      if (msg?.messageType === 'videoMessage') {
        return { video: msg?.message?.videoMessage, caption: data.text };
      }

      return null;
    } catch (error) {
      this.logger.error(error);
      throw new BadRequestException(error.toString());
    }
  }

  public async updateMessage(data: UpdateMessageDto) {
    const jid = createJid(data.number);

    const options = await this.formatUpdateMessage(data);

    if (!options) {
      this.logger.error('Message not compatible');
      throw new BadRequestException('Message not compatible');
    }

    try {
      const oldMessage: any = await this.getMessage(data.key, true);
      if (this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE) {
        if (!oldMessage) throw new NotFoundException('Message not found');
        if (oldMessage?.key?.remoteJid !== jid) {
          throw new BadRequestException('RemoteJid does not match');
        }
        if (oldMessage?.messageTimestamp > Date.now() + 900000) {
          // 15 minutes in milliseconds
          throw new BadRequestException('Message is older than 15 minutes');
        }
      }

      const messageSent = await this.client.sendMessage(jid, { ...(options as any), edit: data.key });
      if (messageSent) {
        const editedMessage =
          messageSent?.message?.protocolMessage || messageSent?.message?.editedMessage?.message?.protocolMessage;

        if (editedMessage) {
          this.sendDataWebhook(Events.SEND_MESSAGE_UPDATE, editedMessage);
          if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled)
            this.chatwootService.eventWhatsapp(
              'send.message.update',
              { instanceName: this.instance.name, instanceId: this.instance.id },
              editedMessage,
            );

          const messageId = messageSent.message?.protocolMessage?.key?.id;
          if (messageId && this.configService.get<Database>('DATABASE').SAVE_DATA.NEW_MESSAGE) {
            let message = await withDbTimeout(
              this.prismaRepository.message.findFirst({
                where: { key: { path: ['id'], equals: messageId } },
              }),
              'editMessage:findMessage',
            );
            if (!message) throw new NotFoundException('Message not found');

            if (!(message.key.valueOf() as any).fromMe) {
              new BadRequestException('You cannot edit others messages');
            }
            if ((message.key.valueOf() as any)?.deleted) {
              new BadRequestException('You cannot edit deleted messages');
            }

            if (oldMessage.messageType === 'conversation' || oldMessage.messageType === 'extendedTextMessage') {
              oldMessage.message.conversation = data.text;
            } else {
              oldMessage.message[oldMessage.messageType].caption = data.text;
            }
            message = await withDbTimeout(
              this.prismaRepository.message.update({
                where: { id: message.id },
                data: {
                  message: oldMessage.message,
                  status: 'EDITED',
                  messageTimestamp: Math.floor(Date.now() / 1000), // Convert to int32 by dividing by 1000 to get seconds
                },
              }),
              'editMessage:updateMessage',
            );

            if (this.configService.get<Database>('DATABASE').SAVE_DATA.MESSAGE_UPDATE) {
              const messageUpdate: any = {
                messageId: message.id,
                keyId: messageId,
                remoteJid: messageSent.key.remoteJid,
                fromMe: messageSent.key.fromMe,
                participant: messageSent.key?.participant,
                status: 'EDITED',
                instanceId: this.instanceId,
              };
              await withDbTimeout(
                this.prismaRepository.messageUpdate.create({ data: messageUpdate }),
                'editMessage:createMessageUpdate',
              );
            }
          }
        }
      }

      return messageSent;
    } catch (error) {
      this.logger.error(error);
      throw error;
    }
  }

  public async fetchLabels(): Promise<LabelDto[]> {
    const labels = await withDbTimeout(
      this.prismaRepository.label.findMany({ where: { instanceId: this.instanceId } }),
      'fetchLabels:findLabels',
    );

    return labels.map((label) => ({
      color: label.color,
      name: label.name,
      id: label.labelId,
      predefinedId: label.predefinedId,
    }));
  }

  public async handleLabel(data: HandleLabelDto) {
    const whatsappContact = await this.whatsappNumber({ numbers: [data.number] });
    if (whatsappContact.length === 0) {
      throw new NotFoundException('Number not found');
    }
    const contact = whatsappContact[0];
    if (!contact.exists) {
      throw new NotFoundException('Number is not on WhatsApp');
    }

    try {
      if (data.action === 'add') {
        await this.client.addChatLabel(contact.jid, data.labelId);
        await this.addLabel(data.labelId, this.instanceId, contact.jid);

        return { numberJid: contact.jid, labelId: data.labelId, add: true };
      }
      if (data.action === 'remove') {
        await this.client.removeChatLabel(contact.jid, data.labelId);
        await this.removeLabel(data.labelId, this.instanceId, contact.jid);

        return { numberJid: contact.jid, labelId: data.labelId, remove: true };
      }
    } catch (error) {
      throw new BadRequestException(`Unable to ${data.action} label to chat`, error.toString());
    }
  }

  // Group
  private async updateGroupMetadataCache(groupJid: string) {
    try {
      const meta = await this.client.groupMetadata(groupJid);

      const cacheConf = this.configService.get<CacheConf>('CACHE');

      if ((cacheConf?.REDIS?.ENABLED && cacheConf?.REDIS?.URI !== '') || cacheConf?.LOCAL?.ENABLED) {
        this.logger.verbose(`Updating cache for group: ${groupJid}`);
        await groupMetadataCache.set(groupJid, { timestamp: Date.now(), data: meta });
      }

      return meta;
    } catch (error) {
      this.logger.error(error);
      return null;
    }
  }

  private getGroupMetadataCache = async (groupJid: string) => {
    if (!isJidGroup(groupJid)) return null;

    const cacheConf = this.configService.get<CacheConf>('CACHE');

    if ((cacheConf?.REDIS?.ENABLED && cacheConf?.REDIS?.URI !== '') || cacheConf?.LOCAL?.ENABLED) {
      if (await groupMetadataCache?.has(groupJid)) {
        console.log(`Cache request for group: ${groupJid}`);
        const meta = await groupMetadataCache.get(groupJid);

        if (Date.now() - meta.timestamp > 3600000) {
          await this.updateGroupMetadataCache(groupJid);
        }

        return meta.data;
      }

      console.log(`Cache request for group: ${groupJid} - not found`);
      return await this.updateGroupMetadataCache(groupJid);
    }

    return await this.findGroup({ groupJid }, 'inner');
  };

  public async createGroup(create: CreateGroupDto) {
    try {
      const participants = (await this.whatsappNumber({ numbers: create.participants }))
        .filter((participant) => participant.exists)
        .map((participant) => participant.jid);
      const { id } = await this.client.groupCreate(create.subject, participants);

      if (create?.description) {
        await this.client.groupUpdateDescription(id, create.description);
      }

      if (create?.promoteParticipants) {
        await this.updateGParticipant({ groupJid: id, action: 'promote', participants: participants });
      }

      const group = await this.client.groupMetadata(id);

      return group;
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException('Error creating group', error.toString());
    }
  }

  public async updateGroupPicture(picture: GroupPictureDto) {
    try {
      let pic: WAMediaUpload;
      if (isURL(picture.image)) {
        const timestamp = new Date().getTime();
        const parsedURL = new URL(picture.image);
        parsedURL.searchParams.set('timestamp', timestamp.toString());
        const url = parsedURL.toString();

        let config: any = { responseType: 'arraybuffer' };

        if (this.localProxy?.enabled) {
          config = {
            ...config,
            httpsAgent: makeProxyAgent({
              host: this.localProxy.host,
              port: this.localProxy.port,
              protocol: this.localProxy.protocol,
              username: this.localProxy.username,
              password: this.localProxy.password,
            }),
          };
        }

        // ✅ FIX HTTP TIMEOUT: Group profile picture download con timeout 15s
        pic = (await withHttpTimeout(axios.get(url, config), 'profilePicDownload:group')).data;
      } else if (isBase64(picture.image)) {
        pic = Buffer.from(picture.image, 'base64');
      } else {
        throw new BadRequestException('"profilePicture" must be a url or a base64');
      }
      await this.client.updateProfilePicture(picture.groupJid, pic);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error update group picture', error.toString());
    }
  }

  public async updateGroupSubject(data: GroupSubjectDto) {
    try {
      await this.client.groupUpdateSubject(data.groupJid, data.subject);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating group subject', error.toString());
    }
  }

  public async updateGroupDescription(data: GroupDescriptionDto) {
    try {
      await this.client.groupUpdateDescription(data.groupJid, data.description);

      return { update: 'success' };
    } catch (error) {
      throw new InternalServerErrorException('Error updating group description', error.toString());
    }
  }

  public async findGroup(id: GroupJid, reply: 'inner' | 'out' = 'out') {
    try {
      const group = await this.client.groupMetadata(id.groupJid);

      if (!group) {
        this.logger.error('Group not found');
        return null;
      }

      const picture = await this.profilePicture(group.id);

      return {
        id: group.id,
        subject: group.subject,
        subjectOwner: group.subjectOwner,
        subjectTime: group.subjectTime,
        pictureUrl: picture.profilePictureUrl,
        size: group.participants.length,
        creation: group.creation,
        owner: group.owner,
        desc: group.desc,
        descId: group.descId,
        restrict: group.restrict,
        announce: group.announce,
        participants: group.participants,
        isCommunity: group.isCommunity,
        isCommunityAnnounce: group.isCommunityAnnounce,
        linkedParent: group.linkedParent,
      };
    } catch (error) {
      if (reply === 'inner') {
        return;
      }
      throw new NotFoundException('Error fetching group', error.toString());
    }
  }

  public async fetchAllGroups(getParticipants: GetParticipant) {
    const fetch = Object.values(await this?.client?.groupFetchAllParticipating());

    let groups = [];
    for (const group of fetch) {
      const picture = await this.profilePicture(group.id);

      const result = {
        id: group.id,
        subject: group.subject,
        subjectOwner: group.subjectOwner,
        subjectTime: group.subjectTime,
        pictureUrl: picture?.profilePictureUrl,
        size: group.participants.length,
        creation: group.creation,
        owner: group.owner,
        desc: group.desc,
        descId: group.descId,
        restrict: group.restrict,
        announce: group.announce,
        isCommunity: group.isCommunity,
        isCommunityAnnounce: group.isCommunityAnnounce,
        linkedParent: group.linkedParent,
      };

      if (getParticipants.getParticipants == 'true') {
        result['participants'] = group.participants;
      }

      groups = [...groups, result];
    }

    return groups;
  }

  public async inviteCode(id: GroupJid) {
    try {
      const code = await this.client.groupInviteCode(id.groupJid);
      return { inviteUrl: `https://chat.whatsapp.com/${code}`, inviteCode: code };
    } catch (error) {
      throw new NotFoundException('No invite code', error.toString());
    }
  }

  public async inviteInfo(id: GroupInvite) {
    try {
      return await this.client.groupGetInviteInfo(id.inviteCode);
    } catch {
      throw new NotFoundException('No invite info', id.inviteCode);
    }
  }

  public async sendInvite(id: GroupSendInvite) {
    try {
      const inviteCode = await this.inviteCode({ groupJid: id.groupJid });

      const inviteUrl = inviteCode.inviteUrl;

      const numbers = id.numbers.map((number) => createJid(number));
      const description = id.description ?? '';

      const msg = `${description}\n\n${inviteUrl}`;

      const message = { conversation: msg };

      for await (const number of numbers) {
        await this.sendMessageWithTyping(number, message);
      }

      return { send: true, inviteUrl };
    } catch {
      throw new NotFoundException('No send invite');
    }
  }

  public async acceptInviteCode(id: AcceptGroupInvite) {
    try {
      const groupJid = await this.client.groupAcceptInvite(id.inviteCode);
      return { accepted: true, groupJid: groupJid };
    } catch (error) {
      throw new NotFoundException('Accept invite error', error.toString());
    }
  }

  public async revokeInviteCode(id: GroupJid) {
    try {
      const inviteCode = await this.client.groupRevokeInvite(id.groupJid);
      return { revoked: true, inviteCode };
    } catch (error) {
      throw new NotFoundException('Revoke error', error.toString());
    }
  }

  public async findParticipants(id: GroupJid) {
    try {
      const participants = (await this.client.groupMetadata(id.groupJid)).participants;
      const contacts = await withDbTimeout(
        this.prismaRepository.contact.findMany({
          where: { instanceId: this.instanceId, remoteJid: { in: participants.map((p) => p.id) } },
        }),
        'findParticipants:findContacts',
      );
      const parsedParticipants = participants.map((participant) => {
        const contact = contacts.find((c) => c.remoteJid === participant.id);
        return {
          ...participant,
          name: participant.name ?? contact?.pushName,
          imgUrl: participant.imgUrl ?? contact?.profilePicUrl,
        };
      });

      const usersContacts = parsedParticipants.filter((c) => c.id.includes('@s.whatsapp'));
      if (usersContacts) {
        await saveOnWhatsappCache(usersContacts.map((c) => ({ remoteJid: c.id })));
      }

      return { participants: parsedParticipants };
    } catch (error) {
      console.error(error);
      throw new NotFoundException('No participants', error.toString());
    }
  }

  public async updateGParticipant(update: GroupUpdateParticipantDto) {
    try {
      const participants = update.participants.map((p) => createJid(p));
      const updateParticipants = await this.client.groupParticipantsUpdate(
        update.groupJid,
        participants,
        update.action,
      );
      return { updateParticipants: updateParticipants };
    } catch (error) {
      throw new BadRequestException('Error updating participants', error.toString());
    }
  }

  public async updateGSetting(update: GroupUpdateSettingDto) {
    try {
      const updateSetting = await this.client.groupSettingUpdate(update.groupJid, update.action);
      return { updateSetting: updateSetting };
    } catch (error) {
      throw new BadRequestException('Error updating setting', error.toString());
    }
  }

  public async toggleEphemeral(update: GroupToggleEphemeralDto) {
    try {
      await this.client.groupToggleEphemeral(update.groupJid, update.expiration);
      return { success: true };
    } catch (error) {
      throw new BadRequestException('Error updating setting', error.toString());
    }
  }

  public async leaveGroup(id: GroupJid) {
    try {
      await this.client.groupLeave(id.groupJid);
      return { groupJid: id.groupJid, leave: true };
    } catch (error) {
      throw new BadRequestException('Unable to leave the group', error.toString());
    }
  }

  public async templateMessage() {
    throw new Error('Method not available in the Baileys service');
  }

  private deserializeMessageBuffers(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'object' && !Array.isArray(obj) && !Buffer.isBuffer(obj)) {
      const keys = Object.keys(obj);
      const isIndexedObject = keys.every((key) => !isNaN(Number(key)));

      if (isIndexedObject && keys.length > 0) {
        const values = keys.sort((a, b) => Number(a) - Number(b)).map((key) => obj[key]);
        return new Uint8Array(values);
      }
    }

    // Is Buffer?, converter to Uint8Array
    if (Buffer.isBuffer(obj)) {
      return new Uint8Array(obj);
    }

    // Process arrays recursively
    if (Array.isArray(obj)) {
      return obj.map((item) => this.deserializeMessageBuffers(item));
    }

    // Process objects recursively
    if (typeof obj === 'object') {
      const converted: any = {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          converted[key] = this.deserializeMessageBuffers(obj[key]);
        }
      }
      return converted;
    }

    return obj;
  }

  private normalizeMessageKey(key: proto.IMessageKey): any {
    const normalizedKey = { ...key };

    // Se addressingMode è 'pn' (phone number), i campi sono invertiti rispetto a 'lid'
    // Vogliamo che remoteJidAlt contenga SEMPRE il numero di telefono
    if ((key as any).addressingMode === 'pn' || !(key as any).addressingMode) {
      // Da web/desktop: remoteJid = numero telefono, remoteJidAlt = LID
      // Invertiamo: remoteJid = LID, remoteJidAlt = numero telefono
      const phoneNumber = key.remoteJid;
      const lid = (key as any).remoteJidAlt;

      if (phoneNumber && phoneNumber.includes('@s.whatsapp.net') && lid) {
        normalizedKey.remoteJid = lid;
        (normalizedKey as any).remoteJidAlt = phoneNumber;
      }

      // Stesso per participant/participantAlt nei gruppi
      const participantPhone = key.participant;
      const participantLid = (key as any).participantAlt;

      if (participantPhone && participantPhone.includes('@s.whatsapp.net') && participantLid) {
        normalizedKey.participant = participantLid;
        (normalizedKey as any).participantAlt = participantPhone;
      }
    }
    // Se addressingMode è 'lid', i campi sono già nel formato corretto:
    // remoteJid = LID, remoteJidAlt = numero telefono

    return normalizedKey;
  }

  private prepareMessage(message: proto.IWebMessageInfo): any {
    const contentType = getContentType(message.message);
    const contentMsg = message?.message[contentType] as any;

    const messageRaw = {
      key: this.normalizeMessageKey(message.key), // Normalized: remoteJidAlt always contains phone number
      pushName:
        message.pushName ||
        (message.key.fromMe
          ? 'Você'
          : message?.participant || (message.key?.participant ? message.key.participant.split('@')[0] : null)),
      status: status[message.status],
      message: this.deserializeMessageBuffers({ ...message.message }),
      contextInfo: this.deserializeMessageBuffers(contentMsg?.contextInfo),
      messageType: contentType || 'unknown',
      messageTimestamp: Long.isLong(message.messageTimestamp)
        ? message.messageTimestamp.toNumber()
        : (message.messageTimestamp as number),
      instanceId: this.instanceId,
      source: getDevice(message.key.id),
    };

    if (!messageRaw.status && message.key.fromMe === false) {
      messageRaw.status = status[3]; // DELIVERED MESSAGE
    }

    if (messageRaw.message.extendedTextMessage) {
      messageRaw.messageType = 'conversation';
      messageRaw.message.conversation = messageRaw.message.extendedTextMessage.text;
      delete messageRaw.message.extendedTextMessage;
    }

    if (messageRaw.message.documentWithCaptionMessage) {
      messageRaw.messageType = 'documentMessage';
      messageRaw.message.documentMessage = messageRaw.message.documentWithCaptionMessage.message.documentMessage;
      delete messageRaw.message.documentWithCaptionMessage;
    }

    const quotedMessage = messageRaw?.contextInfo?.quotedMessage;
    if (quotedMessage) {
      if (quotedMessage.extendedTextMessage) {
        quotedMessage.conversation = quotedMessage.extendedTextMessage.text;
        delete quotedMessage.extendedTextMessage;
      }

      if (quotedMessage.documentWithCaptionMessage) {
        quotedMessage.documentMessage = quotedMessage.documentWithCaptionMessage.message.documentMessage;
        delete quotedMessage.documentWithCaptionMessage;
      }
    }

    return messageRaw;
  }

  private async syncChatwootLostMessages() {
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED && this.localChatwoot?.enabled) {
      const chatwootConfig = await this.findChatwoot();
      const prepare = (message: any) => this.prepareMessage(message);
      this.chatwootService.syncLostMessages({ instanceName: this.instance.name }, chatwootConfig, prepare);

      // Generate ID for this cron task and store in cache
      const cronId = cuid();
      const cronKey = `chatwoot:syncLostMessages`;
      await this.chatwootService.getCache()?.hSet(cronKey, this.instance.name, cronId);

      const task = cron.schedule('0,30 * * * *', async () => {
        // Check ID before executing (only if cache is available)
        const cache = this.chatwootService.getCache();
        if (cache) {
          const storedId = await cache.hGet(cronKey, this.instance.name);
          if (storedId && storedId !== cronId) {
            this.logger.info(`Stopping syncChatwootLostMessages cron - ID mismatch: ${cronId} vs ${storedId}`);
            task.stop();
            return;
          }
        }
        this.chatwootService.syncLostMessages({ instanceName: this.instance.name }, chatwootConfig, prepare);
      });
      task.start();
    }
  }

  private async updateMessagesReadedByTimestamp(remoteJid: string, timestamp?: number): Promise<number> {
    if (timestamp === undefined || timestamp === null) return 0;

    // Use raw SQL to avoid JSON path issues
    const result = await withDbTimeout(
      this.prismaRepository.$executeRaw`
        UPDATE "Message"
        SET "status" = ${status[4]}
        WHERE "instanceId" = ${this.instanceId}
        AND "key"->>'remoteJid' = ${remoteJid}
        AND ("key"->>'fromMe')::boolean = false
        AND "messageTimestamp" <= ${timestamp}
        AND ("status" IS NULL OR "status" = ${status[3]})
      `,
      'updateMessagesReaded:executeRaw',
    );

    if (result) {
      if (result > 0) {
        this.updateChatUnreadMessages(remoteJid);
      }

      return result;
    }

    return 0;
  }

  private async updateChatUnreadMessages(remoteJid: string): Promise<number> {
    const [chat, unreadMessages] = await Promise.all([
      withDbTimeout(
        this.prismaRepository.chat.findFirst({ where: { remoteJid } }),
        'updateChatUnreadMessages:findChat',
      ),
      // Use raw SQL to avoid JSON path issues
      withDbTimeout(
        this.prismaRepository.$queryRaw`
          SELECT COUNT(*)::int as count FROM "Message"
          WHERE "instanceId" = ${this.instanceId}
          AND "key"->>'remoteJid' = ${remoteJid}
          AND ("key"->>'fromMe')::boolean = false
          AND "status" = ${status[3]}
        `.then((result: any[]) => result[0]?.count || 0),
        'updateChatUnreadMessages:countMessages',
      ),
    ]);

    if (chat && chat.unreadMessages !== unreadMessages) {
      await withDbTimeout(
        this.prismaRepository.chat.update({ where: { id: chat.id }, data: { unreadMessages } }),
        'updateChatUnreadMessages:updateChat',
      );
    }

    return unreadMessages;
  }

  private async addLabel(labelId: string, instanceId: string, chatId: string) {
    const id = cuid();

    await withDbTimeout(
      this.prismaRepository.$executeRawUnsafe(
        `INSERT INTO "Chat" ("id", "instanceId", "remoteJid", "labels", "createdAt", "updatedAt")
         VALUES ($4, $2, $3, to_jsonb(ARRAY[$1]::text[]), NOW(), NOW()) ON CONFLICT ("instanceId", "remoteJid")
       DO
        UPDATE
            SET "labels" = (
            SELECT to_jsonb(array_agg(DISTINCT elem))
            FROM (
            SELECT jsonb_array_elements_text("Chat"."labels") AS elem
            UNION
            SELECT $1::text AS elem
            ) sub
            ),
            "updatedAt" = NOW();`,
        labelId,
        instanceId,
        chatId,
        id,
      ),
      'addLabel:executeRawUnsafe',
    );
  }

  private async removeLabel(labelId: string, instanceId: string, chatId: string) {
    const id = cuid();

    await withDbTimeout(
      this.prismaRepository.$executeRawUnsafe(
        `INSERT INTO "Chat" ("id", "instanceId", "remoteJid", "labels", "createdAt", "updatedAt")
         VALUES ($4, $2, $3, '[]'::jsonb, NOW(), NOW()) ON CONFLICT ("instanceId", "remoteJid")
       DO
        UPDATE
            SET "labels" = COALESCE (
            (
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements_text("Chat"."labels") AS elem
            WHERE elem <> $1
            ),
            '[]'::jsonb
            ),
            "updatedAt" = NOW();`,
        labelId,
        instanceId,
        chatId,
        id,
      ),
      'removeLabel:executeRawUnsafe',
    );
  }

  public async baileysOnWhatsapp(jid: string) {
    const response = await this.client.onWhatsApp(jid);

    return response;
  }

  public async baileysProfilePictureUrl(jid: string, type: 'image' | 'preview', timeoutMs: number) {
    const response = await this.client.profilePictureUrl(jid, type, timeoutMs);

    return response;
  }

  public async baileysAssertSessions(jids: string[]) {
    const response = await this.client.assertSessions(jids);

    return response;
  }

  public async baileysCreateParticipantNodes(jids: string[], message: proto.IMessage, extraAttrs: any) {
    const response = await this.client.createParticipantNodes(jids, message, extraAttrs);

    const convertedResponse = {
      ...response,
      nodes: response.nodes.map((node: any) => ({
        ...node,
        content: node.content?.map((c: any) => ({
          ...c,
          content: c.content instanceof Uint8Array ? Buffer.from(c.content).toString('base64') : c.content,
        })),
      })),
    };

    return convertedResponse;
  }

  public async baileysSendNode(stanza: any) {
    console.log('stanza', JSON.stringify(stanza));
    const response = await this.client.sendNode(stanza);

    return response;
  }

  public async baileysGetUSyncDevices(jids: string[], useCache: boolean, ignoreZeroDevices: boolean) {
    const response = await this.client.getUSyncDevices(jids, useCache, ignoreZeroDevices);

    return response;
  }

  public async baileysGenerateMessageTag() {
    const response = await this.client.generateMessageTag();

    return response;
  }

  public async baileysSignalRepositoryDecryptMessage(jid: string, type: 'pkmsg' | 'msg', ciphertext: string) {
    try {
      const ciphertextBuffer = Buffer.from(ciphertext, 'base64');

      const response = await this.client.signalRepository.decryptMessage({ jid, type, ciphertext: ciphertextBuffer });

      return response instanceof Uint8Array ? Buffer.from(response).toString('base64') : response;
    } catch (error) {
      this.logger.error('Error decrypting message:');
      this.logger.error(error);
      throw error;
    }
  }

  public async baileysGetAuthState() {
    const response = { me: this.client.authState.creds.me, account: this.client.authState.creds.account };

    return response;
  }

  //Business Controller
  public async fetchCatalog(instanceName: string, data: getCollectionsDto) {
    const jid = data.number ? createJid(data.number) : this.client?.user?.id;
    const limit = data.limit || 10;
    const cursor = null;

    const onWhatsapp = (await this.whatsappNumber({ numbers: [jid] }))?.shift();

    if (!onWhatsapp.exists) {
      throw new BadRequestException(onWhatsapp);
    }

    try {
      const info = (await this.whatsappNumber({ numbers: [jid] }))?.shift();
      const business = await this.fetchBusinessProfile(info?.jid);

      let catalog = await this.getCatalog({ jid: info?.jid, limit, cursor });
      let nextPageCursor = catalog.nextPageCursor;
      let nextPageCursorJson = nextPageCursor ? JSON.parse(atob(nextPageCursor)) : null;
      let pagination = nextPageCursorJson?.pagination_cursor
        ? JSON.parse(atob(nextPageCursorJson.pagination_cursor))
        : null;
      let fetcherHasMore = pagination?.fetcher_has_more === true ? true : false;

      let productsCatalog = catalog.products || [];
      let countLoops = 0;
      while (fetcherHasMore && countLoops < 4) {
        catalog = await this.getCatalog({ jid: info?.jid, limit, cursor: nextPageCursor });
        nextPageCursor = catalog.nextPageCursor;
        nextPageCursorJson = nextPageCursor ? JSON.parse(atob(nextPageCursor)) : null;
        pagination = nextPageCursorJson?.pagination_cursor
          ? JSON.parse(atob(nextPageCursorJson.pagination_cursor))
          : null;
        fetcherHasMore = pagination?.fetcher_has_more === true ? true : false;
        productsCatalog = [...productsCatalog, ...catalog.products];
        countLoops++;
      }

      return {
        wuid: info?.jid || jid,
        numberExists: info?.exists,
        isBusiness: business.isBusiness,
        catalogLength: productsCatalog.length,
        catalog: productsCatalog,
      };
    } catch (error) {
      console.log(error);
      return { wuid: jid, name: null, isBusiness: false };
    }
  }

  public async getCatalog({
    jid,
    limit,
    cursor,
  }: GetCatalogOptions): Promise<{ products: Product[]; nextPageCursor: string | undefined }> {
    try {
      jid = jid ? createJid(jid) : this.instance.wuid;

      const catalog = await this.client.getCatalog({ jid, limit: limit, cursor: cursor });

      if (!catalog) {
        return { products: undefined, nextPageCursor: undefined };
      }

      return catalog;
    } catch (error) {
      throw new InternalServerErrorException('Error getCatalog', error.toString());
    }
  }

  public async fetchCollections(instanceName: string, data: getCollectionsDto) {
    const jid = data.number ? createJid(data.number) : this.client?.user?.id;
    const limit = data.limit <= 20 ? data.limit : 20; //(tem esse limite, não sei porque)

    const onWhatsapp = (await this.whatsappNumber({ numbers: [jid] }))?.shift();

    if (!onWhatsapp.exists) {
      throw new BadRequestException(onWhatsapp);
    }

    try {
      const info = (await this.whatsappNumber({ numbers: [jid] }))?.shift();
      const business = await this.fetchBusinessProfile(info?.jid);
      const collections = await this.getCollections(info?.jid, limit);

      return {
        wuid: info?.jid || jid,
        name: info?.name,
        numberExists: info?.exists,
        isBusiness: business.isBusiness,
        collectionsLength: collections?.length,
        collections: collections,
      };
    } catch {
      return { wuid: jid, name: null, isBusiness: false };
    }
  }

  public async getCollections(jid?: string | undefined, limit?: number): Promise<CatalogCollection[]> {
    try {
      jid = jid ? createJid(jid) : this.instance.wuid;

      const result = await this.client.getCollections(jid, limit);

      if (!result) {
        return [{ id: undefined, name: undefined, products: [], status: undefined }];
      }

      return result.collections;
    } catch (error) {
      throw new InternalServerErrorException('Error getCatalog', error.toString());
    }
  }

  public async fetchMessages(query: Query<Message>) {
    const keyFilters = query?.where?.key as ExtendedIMessageKey;

    const timestampFilter = {};
    if (query?.where?.messageTimestamp) {
      if (query.where.messageTimestamp['gte'] && query.where.messageTimestamp['lte']) {
        timestampFilter['messageTimestamp'] = {
          gte: Math.floor(new Date(query.where.messageTimestamp['gte']).getTime() / 1000),
          lte: Math.floor(new Date(query.where.messageTimestamp['lte']).getTime() / 1000),
        };
      }
    }

    const count = await withDbTimeout(
      this.prismaRepository.message.count({
        where: {
          instanceId: this.instanceId,
          id: query?.where?.id,
          source: query?.where?.source,
          messageType: query?.where?.messageType,
          ...timestampFilter,
          AND: [
            keyFilters?.id ? { key: { path: ['id'], equals: keyFilters?.id } } : {},
            keyFilters?.fromMe ? { key: { path: ['fromMe'], equals: keyFilters?.fromMe } } : {},
            keyFilters?.remoteJid ? { key: { path: ['remoteJid'], equals: keyFilters?.remoteJid } } : {},
            keyFilters?.participant ? { key: { path: ['participant'], equals: keyFilters?.participant } } : {},
            {
              OR: [
                keyFilters?.remoteJid ? { key: { path: ['remoteJid'], equals: keyFilters?.remoteJid } } : {},
                keyFilters?.remoteJidAlt ? { key: { path: ['remoteJidAlt'], equals: keyFilters?.remoteJidAlt } } : {},
              ],
            },
          ],
        },
      }),
      'fetchMessages:countMessages',
    );

    if (!query?.offset) {
      query.offset = 50;
    }

    if (!query?.page) {
      query.page = 1;
    }

    const messages = await withDbTimeout(
      this.prismaRepository.message.findMany({
        where: {
          instanceId: this.instanceId,
          id: query?.where?.id,
          source: query?.where?.source,
          messageType: query?.where?.messageType,
          ...timestampFilter,
          AND: [
            keyFilters?.id ? { key: { path: ['id'], equals: keyFilters?.id } } : {},
            keyFilters?.fromMe ? { key: { path: ['fromMe'], equals: keyFilters?.fromMe } } : {},
            keyFilters?.remoteJid ? { key: { path: ['remoteJid'], equals: keyFilters?.remoteJid } } : {},
            keyFilters?.participant ? { key: { path: ['participant'], equals: keyFilters?.participant } } : {},
            {
              OR: [
                keyFilters?.remoteJid ? { key: { path: ['remoteJid'], equals: keyFilters?.remoteJid } } : {},
                keyFilters?.remoteJidAlt ? { key: { path: ['remoteJidAlt'], equals: keyFilters?.remoteJidAlt } } : {},
              ],
            },
          ],
        },
        orderBy: { messageTimestamp: 'desc' },
        skip: query.offset * (query?.page === 1 ? 0 : (query?.page as number) - 1),
        take: query.offset,
        select: {
          id: true,
          key: true,
          pushName: true,
          messageType: true,
          message: true,
          messageTimestamp: true,
          instanceId: true,
          source: true,
          contextInfo: true,
          MessageUpdate: { select: { status: true } },
        },
      }),
      'fetchMessages:findMessages',
    );

    const formattedMessages = messages.map((message) => {
      const messageKey = message.key as { fromMe: boolean; remoteJid: string; id: string; participant?: string };

      if (!message.pushName) {
        if (messageKey.fromMe) {
          message.pushName = 'Você';
        } else if (message.contextInfo) {
          const contextInfo = message.contextInfo as { participant?: string };
          if (contextInfo.participant) {
            message.pushName = contextInfo.participant.split('@')[0];
          } else if (messageKey.participant) {
            message.pushName = messageKey.participant.split('@')[0];
          }
        }
      }

      return message;
    });

    return {
      messages: {
        total: count,
        pages: Math.ceil(count / query.offset),
        currentPage: query.page,
        records: formattedMessages,
      },
    };
  }
}
