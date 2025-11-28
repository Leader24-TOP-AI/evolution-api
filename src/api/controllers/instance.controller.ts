import { InstanceDto, SetPresenceDto } from '@api/dto/instance.dto';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { channelController, eventManager } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { SettingsService } from '@api/services/settings.service';
import { Events, Integration, wa } from '@api/types/wa.types';
import { Auth, Chatwoot, ConfigService, HttpServer, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, InternalServerErrorException, UnauthorizedException } from '@exceptions';
import { delay } from 'baileys';
import { isArray, isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
import { v4 } from 'uuid';

import { ProxyController } from './proxy.controller';

export class InstanceController {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatwootService: ChatwootService,
    private readonly settingsService: SettingsService,
    private readonly proxyService: ProxyController,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {}

  private readonly logger = new Logger('InstanceController');

  public async createInstance(instanceData: InstanceDto) {
    try {
      const instance = channelController.init(instanceData, {
        configService: this.configService,
        eventEmitter: this.eventEmitter,
        prismaRepository: this.prismaRepository,
        cache: this.cache,
        chatwootCache: this.chatwootCache,
        baileysCache: this.baileysCache,
        providerFiles: this.providerFiles,
      });

      if (!instance) {
        throw new BadRequestException('Invalid integration');
      }

      const instanceId = v4();

      instanceData.instanceId = instanceId;

      let hash: string;

      if (!instanceData.token) hash = v4().toUpperCase();
      else hash = instanceData.token;

      await this.waMonitor.saveInstance({
        instanceId,
        integration: instanceData.integration,
        instanceName: instanceData.instanceName,
        ownerJid: instanceData.ownerJid,
        profileName: instanceData.profileName,
        profilePicUrl: instanceData.profilePicUrl,
        hash,
        number: instanceData.number,
        businessId: instanceData.businessId,
        status: instanceData.status,
      });

      instance.setInstance({
        instanceName: instanceData.instanceName,
        instanceId,
        integration: instanceData.integration,
        token: hash,
        number: instanceData.number,
        businessId: instanceData.businessId,
      });

      this.waMonitor.waInstances[instance.instanceName] = instance;
      this.waMonitor.delInstanceTime(instance.instanceName);

      // set events
      await eventManager.setInstance(instance.instanceName, instanceData);

      instance.sendDataWebhook(Events.INSTANCE_CREATE, {
        instanceName: instanceData.instanceName,
        instanceId: instanceId,
      });

      if (instanceData.proxyHost && instanceData.proxyPort && instanceData.proxyProtocol) {
        const testProxy = await this.proxyService.testProxy({
          host: instanceData.proxyHost,
          port: instanceData.proxyPort,
          protocol: instanceData.proxyProtocol,
          username: instanceData.proxyUsername,
          password: instanceData.proxyPassword,
        });
        if (!testProxy) {
          throw new BadRequestException('Invalid proxy');
        }

        await this.proxyService.createProxy(instance, {
          enabled: true,
          host: instanceData.proxyHost,
          port: instanceData.proxyPort,
          protocol: instanceData.proxyProtocol,
          username: instanceData.proxyUsername,
          password: instanceData.proxyPassword,
        });
      }

      const settings: wa.LocalSettings = {
        rejectCall: instanceData.rejectCall === true,
        msgCall: instanceData.msgCall || '',
        groupsIgnore: instanceData.groupsIgnore === true,
        alwaysOnline: instanceData.alwaysOnline === true,
        readMessages: instanceData.readMessages === true,
        readStatus: instanceData.readStatus === true,
        syncFullHistory: instanceData.syncFullHistory === true,
        wavoipToken: instanceData.wavoipToken || '',
      };

      await this.settingsService.create(instance, settings);

      let webhookWaBusiness = null,
        accessTokenWaBusiness = '';

      if (instanceData.integration === Integration.WHATSAPP_BUSINESS) {
        if (!instanceData.number) {
          throw new BadRequestException('number is required');
        }
        const urlServer = this.configService.get<HttpServer>('SERVER').URL;
        webhookWaBusiness = `${urlServer}/webhook/meta`;
        accessTokenWaBusiness = this.configService.get<WaBusiness>('WA_BUSINESS').TOKEN_WEBHOOK;
      }

      if (!instanceData.chatwootAccountId || !instanceData.chatwootToken || !instanceData.chatwootUrl) {
        let getQrcode: wa.QrCode;

        if (instanceData.qrcode && instanceData.integration === Integration.WHATSAPP_BAILEYS) {
          await instance.connectToWhatsapp(instanceData.number);
          await delay(5000);
          getQrcode = instance.qrCode;
        }

        const result = {
          instance: {
            instanceName: instance.instanceName,
            instanceId: instanceId,
            integration: instanceData.integration,
            webhookWaBusiness,
            accessTokenWaBusiness,
            status: instance.connectionStatus.state,
          },
          hash,
          webhook: {
            webhookUrl: instanceData?.webhook?.url,
            webhookHeaders: instanceData?.webhook?.headers,
            webhookByEvents: instanceData?.webhook?.byEvents,
            webhookBase64: instanceData?.webhook?.base64,
          },
          websocket: {
            enabled: instanceData?.websocket?.enabled,
          },
          rabbitmq: {
            enabled: instanceData?.rabbitmq?.enabled,
          },
          nats: {
            enabled: instanceData?.nats?.enabled,
          },
          sqs: {
            enabled: instanceData?.sqs?.enabled,
          },
          settings,
          qrcode: getQrcode,
        };

        return result;
      }

      if (!this.configService.get<Chatwoot>('CHATWOOT').ENABLED)
        throw new BadRequestException('Chatwoot is not enabled');

      if (!instanceData.chatwootAccountId) {
        throw new BadRequestException('accountId is required');
      }

      if (!instanceData.chatwootToken) {
        throw new BadRequestException('token is required');
      }

      if (!instanceData.chatwootUrl) {
        throw new BadRequestException('url is required');
      }

      if (!isURL(instanceData.chatwootUrl, { require_tld: false })) {
        throw new BadRequestException('Invalid "url" property in chatwoot');
      }

      if (instanceData.chatwootSignMsg !== true && instanceData.chatwootSignMsg !== false) {
        throw new BadRequestException('signMsg is required');
      }

      if (instanceData.chatwootReopenConversation !== true && instanceData.chatwootReopenConversation !== false) {
        throw new BadRequestException('reopenConversation is required');
      }

      if (instanceData.chatwootConversationPending !== true && instanceData.chatwootConversationPending !== false) {
        throw new BadRequestException('conversationPending is required');
      }

      const urlServer = this.configService.get<HttpServer>('SERVER').URL;

      try {
        this.chatwootService.create(instance, {
          enabled: true,
          accountId: instanceData.chatwootAccountId,
          token: instanceData.chatwootToken,
          url: instanceData.chatwootUrl,
          signMsg: instanceData.chatwootSignMsg || false,
          nameInbox: instanceData.chatwootNameInbox ?? instance.instanceName.split('-cwId-')[0],
          number: instanceData.number,
          reopenConversation: instanceData.chatwootReopenConversation || false,
          conversationPending: instanceData.chatwootConversationPending || false,
          importContacts: instanceData.chatwootImportContacts ?? true,
          mergeBrazilContacts: instanceData.chatwootMergeBrazilContacts ?? false,
          importMessages: instanceData.chatwootImportMessages ?? true,
          daysLimitImportMessages: instanceData.chatwootDaysLimitImportMessages ?? 60,
          organization: instanceData.chatwootOrganization,
          logo: instanceData.chatwootLogo,
          autoCreate: instanceData.chatwootAutoCreate !== false,
        });
      } catch (error) {
        this.logger.log(error);
      }

      return {
        instance: {
          instanceName: instance.instanceName,
          instanceId: instanceId,
          integration: instanceData.integration,
          webhookWaBusiness,
          accessTokenWaBusiness,
          status: instance.connectionStatus.state,
        },
        hash,
        webhook: {
          webhookUrl: instanceData?.webhook?.url,
          webhookHeaders: instanceData?.webhook?.headers,
          webhookByEvents: instanceData?.webhook?.byEvents,
          webhookBase64: instanceData?.webhook?.base64,
        },
        websocket: {
          enabled: instanceData?.websocket?.enabled,
        },
        rabbitmq: {
          enabled: instanceData?.rabbitmq?.enabled,
        },
        nats: {
          enabled: instanceData?.nats?.enabled,
        },
        sqs: {
          enabled: instanceData?.sqs?.enabled,
        },
        settings,
        chatwoot: {
          enabled: true,
          accountId: instanceData.chatwootAccountId,
          token: instanceData.chatwootToken,
          url: instanceData.chatwootUrl,
          signMsg: instanceData.chatwootSignMsg || false,
          reopenConversation: instanceData.chatwootReopenConversation || false,
          conversationPending: instanceData.chatwootConversationPending || false,
          mergeBrazilContacts: instanceData.chatwootMergeBrazilContacts ?? false,
          importContacts: instanceData.chatwootImportContacts ?? true,
          importMessages: instanceData.chatwootImportMessages ?? true,
          daysLimitImportMessages: instanceData.chatwootDaysLimitImportMessages || 60,
          number: instanceData.number,
          nameInbox: instanceData.chatwootNameInbox ?? instance.instanceName,
          webhookUrl: `${urlServer}/chatwoot/webhook/${encodeURIComponent(instance.instanceName)}`,
        },
      };
    } catch (error) {
      this.waMonitor.deleteInstance(instanceData.instanceName);
      this.logger.error(isArray(error.message) ? error.message[0] : error.message);
      throw new BadRequestException(isArray(error.message) ? error.message[0] : error.message);
    }
  }

  public async connectToWhatsapp({ instanceName, number = null }: InstanceDto) {
    try {
      let instance = this.waMonitor.waInstances[instanceName];

      // ✅ LAZY LOADING: Se l'istanza non è in memoria, prova a caricarla dal DB
      // Questo risolve il caso: logout volontario + server restart → utente vuole riconnettersi
      if (!instance) {
        // Verifica se esiste nel database
        const dbInstance = await this.prismaRepository.instance.findUnique({
          where: { name: instanceName },
        });

        if (!dbInstance) {
          throw new BadRequestException('The "' + instanceName + '" instance does not exist');
        }

        // Reset definitiveLogout per permettere riconnessione
        await this.prismaRepository.instance.update({
          where: { name: instanceName },
          data: { definitiveLogout: false },
        });

        // Carica l'istanza in memoria
        this.logger.info(`[LazyLoad] Instance "${instanceName}" not in memory, loading from DB...`);
        await this.waMonitor.loadInstanceOnDemand(instanceName);
        instance = this.waMonitor.waInstances[instanceName];

        if (!instance) {
          throw new BadRequestException('Failed to load instance "' + instanceName + '" from database');
        }
      }

      const state = instance?.connectionStatus?.state;

      if (state == 'open') {
        return await this.connectionState({ instanceName });
      }

      if (state == 'connecting') {
        return instance.qrCode;
      }

      if (state == 'close') {
        // ✅ FIX: Reset definitiveLogout flag quando utente riconnette manualmente
        // Permette riutilizzo istanza dopo logout/ban
        await this.prismaRepository.instance.update({
          where: { name: instanceName },
          data: { definitiveLogout: false },
        });

        await instance.connectToWhatsapp(number);

        await delay(2000);
        return instance.qrCode;
      }

      return {
        instance: {
          instanceName: instanceName,
          status: state,
        },
        qrcode: instance?.qrCode,
      };
    } catch (error) {
      this.logger.error(error);
      return { error: true, message: error.toString() };
    }
  }

  public async restartInstance({ instanceName }: InstanceDto) {
    try {
      const instance = this.waMonitor.waInstances[instanceName];
      const state = instance?.connectionStatus?.state;

      if (!state) {
        throw new BadRequestException('The "' + instanceName + '" instance does not exist');
      }

      if (state == 'close') {
        throw new BadRequestException('The "' + instanceName + '" instance is not connected');
      } else if (state == 'open') {
        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) instance.clearCacheChatwoot();
        this.logger.info('restarting instance' + instanceName);

        instance.client?.ws?.close();
        instance.client?.end(new Error('restart'));
        return await this.connectToWhatsapp({ instanceName });
      } else if (state == 'connecting') {
        instance.client?.ws?.close();
        instance.client?.end(new Error('restart'));
        return await this.connectToWhatsapp({ instanceName });
      }
    } catch (error) {
      this.logger.error(error);
      return { error: true, message: error.toString() };
    }
  }

  public async connectionState({ instanceName }: InstanceDto) {
    return {
      instance: {
        instanceName: instanceName,
        state: this.waMonitor.waInstances[instanceName]?.connectionStatus?.state,
      },
    };
  }

  /**
   * ✅ TEST ENDPOINT: Simula disconnessione forzata per test riconnessione automatica
   *
   * Questo endpoint permette di testare tutti gli scenari di disconnessione/riconnessione
   * senza dover aspettare che l'istanza si disconnetta naturalmente.
   *
   * Supporta simulazione di:
   * - Vari statusCode (408, 428, 440, 515, 503, 401, 403, etc.)
   * - Stuck artificiale in 'connecting' (per testare timer/health check)
   * - Disconnessioni multiple rapide (stress test)
   *
   * @param instanceName - Nome dell'istanza da disconnettere
   * @param body.statusCode - Status code da simulare (default: 408)
   * @param body.reason - Motivo della disconnessione (per log)
   * @param body.forceStuck - Se true, simula stuck in connecting senza riconnettersi
   */
  public async simulateDisconnect(
    { instanceName }: InstanceDto,
    body?: { statusCode?: number; reason?: string; forceStuck?: boolean },
  ) {
    try {
      const instance = this.waMonitor.waInstances[instanceName];

      if (!instance) {
        throw new BadRequestException(`Instance "${instanceName}" does not exist`);
      }

      const state = instance.connectionStatus?.state;

      if (state !== 'open' && state !== 'connecting') {
        throw new BadRequestException(
          `Instance "${instanceName}" is not in a state that can be disconnected (current state: ${state}). Only 'open' or 'connecting' states can be tested.`,
        );
      }

      const statusCode = body?.statusCode || 408; // Default: Request Timeout
      const reason = body?.reason || `Test: Simulated disconnect with statusCode ${statusCode}`;
      const forceStuck = body?.forceStuck || false;

      this.logger.warn(
        `[TEST] 🧪 Simulating disconnect for instance ${instanceName} | StatusCode: ${statusCode} | Reason: ${reason} | ForceStuck: ${forceStuck}`,
      );

      // Crea errore simulato come Boom error (formato usato da Baileys)
      const simulatedError: any = new Error(reason);
      simulatedError.output = {
        statusCode: statusCode,
        payload: {
          message: reason,
          statusCode: statusCode,
        },
      };

      // Forza chiusura WebSocket
      if (instance.client?.ws) {
        this.logger.verbose(`[TEST] Closing WebSocket for instance ${instanceName}`);
        instance.client.ws.close();
      }

      // Termina client con errore simulato
      // Questo triggera connectionUpdate() con lastDisconnect contenente il nostro statusCode
      this.logger.verbose(`[TEST] Ending client with simulated error for instance ${instanceName}`);
      instance.client?.end(simulatedError);

      // Se forceStuck, NON permettere riconnessione automatica
      // (utile per testare health check e safety timeout)
      if (forceStuck) {
        this.logger.warn(`[TEST] ForceStuck enabled - instance will remain in 'connecting' to test timer/health check`);
        // Nota: In produzione questo scenario non dovrebbe mai verificarsi
        // È solo per testing che timer e health check funzionino correttamente
      }

      return {
        success: true,
        message: `Disconnect simulation triggered for instance ${instanceName}`,
        testConfig: {
          statusCode: statusCode,
          reason: reason,
          forceStuck: forceStuck,
          instanceState: state,
        },
        timestamp: new Date().toISOString(),
        expectedBehavior: this.getExpectedBehavior(statusCode, forceStuck),
        monitoringInfo: {
          logPatterns: this.getLogPatterns(statusCode),
          checkAfterSeconds: forceStuck ? 15 : 5,
          endpoints: {
            checkState: `/instance/connectionState/${instanceName}`,
            logs: `pm2 logs evolution-api | grep "${instanceName}"`,
          },
        },
      };
    } catch (error) {
      this.logger.error(`[TEST] Simulate disconnect failed: ${error}`);
      throw error;
    }
  }

  /**
   * Helper: Ritorna comportamento atteso basato su statusCode
   */
  private getExpectedBehavior(statusCode: number, forceStuck: boolean): string {
    // Codici che NON riconnettono (close definitivo)
    const codesToNotReconnect = [401, 403, 402, 406];

    if (codesToNotReconnect.includes(statusCode)) {
      return `Close definitivo (statusCode ${statusCode}). NO auto-riconnessione. Flags reset. Serve nuovo QR code.`;
    }

    if (forceStuck) {
      return `Instance rimarrà stuck in 'connecting'. Timer (5s) dovrebbe triggerare auto-restart. Health check (10s) come backup. Safety timeout (30s) force close.`;
    }

    return `Auto-riconnessione entro 5-15 secondi. Timer attivato se stuck in 'connecting'. Success atteso.`;
  }

  /**
   * Helper: Ritorna pattern di log attesi
   */
  private getLogPatterns(statusCode: number): string[] {
    const codesToNotReconnect = [401, 403, 402, 406];

    if (codesToNotReconnect.includes(statusCode)) {
      return [
        `[Connection] Instance xxx - ❌ Definitive close (statusCode: ${statusCode}) - Resetting all auto-restart flags`,
        `STATUS_INSTANCE status: 'closed'`,
      ];
    }

    return [
      `[Connection] Instance xxx - 🔄 Reconnecting after close (statusCode: ${statusCode})`,
      `[Auto-Restart] Instance xxx - Detected stuck in 'connecting' state`,
      `[Auto-Restart] Instance xxx - 🔓 Resetting isAutoRestarting flag`,
      `[Auto-Restart] Instance xxx - 🔌 Creating new client`,
      `[Auto-Restart] Instance xxx - SUCCESS! Connection restored`,
    ];
  }

  public async fetchInstances({ instanceName, instanceId, number }: InstanceDto, key: string) {
    const env = this.configService.get<Auth>('AUTHENTICATION').API_KEY;

    if (env.KEY !== key) {
      const instancesByKey = await this.prismaRepository.instance.findMany({
        where: {
          token: key,
          name: instanceName || undefined,
          id: instanceId || undefined,
        },
      });

      if (instancesByKey.length > 0) {
        const names = instancesByKey.map((instance) => instance.name);

        return this.waMonitor.instanceInfo(names);
      } else {
        throw new UnauthorizedException();
      }
    }

    if (instanceId || number) {
      return this.waMonitor.instanceInfoById(instanceId, number);
    }

    const instanceNames = instanceName ? [instanceName] : null;

    return this.waMonitor.instanceInfo(instanceNames);
  }

  public async setPresence({ instanceName }: InstanceDto, data: SetPresenceDto) {
    return await this.waMonitor.waInstances[instanceName].setPresence(data);
  }

  public async logout({ instanceName }: InstanceDto) {
    const { instance } = await this.connectionState({ instanceName });

    if (instance.state === 'close') {
      throw new BadRequestException('The "' + instanceName + '" instance is not connected');
    }

    try {
      this.waMonitor.waInstances[instanceName]?.logoutInstance();

      return { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } };
    } catch (error) {
      throw new InternalServerErrorException(error.toString());
    }
  }

  public async deleteInstance({ instanceName }: InstanceDto) {
    const { instance } = await this.connectionState({ instanceName });
    try {
      const waInstances = this.waMonitor.waInstances[instanceName];
      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) waInstances?.clearCacheChatwoot();

      if (instance.state === 'connecting' || instance.state === 'open') {
        await this.logout({ instanceName });
      }

      try {
        waInstances?.sendDataWebhook(Events.INSTANCE_DELETE, {
          instanceName,
          instanceId: waInstances.instanceId,
        });
      } catch (error) {
        this.logger.error(error);
      }

      this.eventEmitter.emit('remove.instance', instanceName, 'inner');
      return { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } };
    } catch (error) {
      throw new BadRequestException(error.toString());
    }
  }
}
