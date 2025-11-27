import {
  ExtractedLocation,
  OxylabsLocationResponse,
  ProxyDashboardItemDto,
  ProxyHistoryDto,
  ProxyStatusDto,
} from '@api/dto/proxy-monitor.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { Proxy, ProxyHistory, ProxyStatus } from '@prisma/client';
import { makeProxyAgent } from '@utils/makeProxyAgent';
import axios from 'axios';
import * as cron from 'node-cron';

import { WAMonitoringService } from './monitor.service';

export class ProxyMonitorService {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly prismaRepository: PrismaRepository,
  ) {}

  private readonly logger = new Logger('ProxyMonitorService');
  private monitoringTask: cron.ScheduledTask | null = null;
  private cleanupTask: cron.ScheduledTask | null = null;
  private readonly POLLING_INTERVAL = '*/3 * * * *'; // Every 3 minutes
  private readonly CLEANUP_INTERVAL = '0 3 * * *'; // Daily at 3 AM
  private readonly RETENTION_DAYS = 7;
  private readonly REQUEST_TIMEOUT = 5000; // 5 seconds
  private readonly BATCH_SIZE = 15;
  private readonly STAGGER_DELAY = 100; // ms between requests

  // Circuit breaker for problematic instances
  private errorCounts: Map<string, number> = new Map();
  private readonly MAX_CONSECUTIVE_ERRORS = 5;

  /**
   * Start the proxy monitoring system
   */
  public startMonitoring(): void {
    this.logger.info('Starting Proxy Monitor Service...');

    // Polling every 3 minutes
    this.monitoringTask = cron.schedule(this.POLLING_INTERVAL, async () => {
      try {
        await this.checkAllInstances();
      } catch (error) {
        this.logger.error(`Error in monitoring task: ${error}`);
      }
    });

    // Daily cleanup at 3 AM
    this.cleanupTask = cron.schedule(this.CLEANUP_INTERVAL, async () => {
      try {
        await this.cleanupOldRecords();
      } catch (error) {
        this.logger.error(`Error in cleanup task: ${error}`);
      }
    });

    this.logger.info('Proxy Monitor Service started - polling every 3 minutes');
  }

  /**
   * Stop the proxy monitoring system
   */
  public stopMonitoring(): void {
    if (this.monitoringTask) {
      this.monitoringTask.stop();
      this.monitoringTask = null;
    }
    if (this.cleanupTask) {
      this.cleanupTask.stop();
      this.cleanupTask = null;
    }
    this.logger.info('Proxy Monitor Service stopped');
  }

  /**
   * Check all instances with enabled proxy
   */
  public async checkAllInstances(): Promise<void> {
    try {
      // Get all instances with proxy enabled
      const instances = await this.prismaRepository.instance.findMany({
        where: {
          Proxy: {
            enabled: true,
          },
        },
        include: {
          Proxy: true,
        },
      });

      if (instances.length === 0) {
        this.logger.verbose('No instances with proxy enabled');
        return;
      }

      this.logger.info(`Checking ${instances.length} instances with proxy...`);

      // Process in batches with staggering
      for (let i = 0; i < instances.length; i += this.BATCH_SIZE) {
        const batch = instances.slice(i, i + this.BATCH_SIZE);
        await Promise.allSettled(
          batch.map((instance, index) =>
            this.checkInstanceWithDelay(instance.name, instance.Proxy!, index * this.STAGGER_DELAY),
          ),
        );
      }

      this.logger.info(`Finished checking ${instances.length} instances`);
    } catch (error) {
      this.logger.error(`Error checking all instances: ${error}`);
    }
  }

  /**
   * Check a single instance with delay (for staggering)
   */
  private async checkInstanceWithDelay(instanceName: string, proxy: Proxy, delay: number): Promise<void> {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    await this.checkInstance(instanceName);
  }

  /**
   * Check a single instance's proxy status
   */
  public async checkInstance(instanceName: string): Promise<ProxyStatusDto | null> {
    try {
      // Skip if too many consecutive errors (circuit breaker)
      if (this.shouldSkipInstance(instanceName)) {
        this.logger.verbose(`Skipping ${instanceName} due to circuit breaker`);
        return null;
      }

      // Get instance with proxy config
      const instance = await this.prismaRepository.instance.findUnique({
        where: { name: instanceName },
        include: { Proxy: true, ProxyStatus: true },
      });

      if (!instance) {
        return null;
      }

      if (!instance.Proxy?.enabled) {
        return this.buildStatusDto(instance, null, 'disabled');
      }

      // Fetch proxy info from Oxylabs
      const proxyInfo = await this.fetchProxyInfo(instance.Proxy);

      if (!proxyInfo) {
        this.recordError(instanceName);
        return this.buildStatusDto(instance, instance.ProxyStatus, 'error', 'Failed to connect to proxy');
      }

      // Clear error count on success
      this.clearError(instanceName);

      // Update proxy status in database
      await this.updateProxyStatus(instance.id, instance.ProxyStatus, proxyInfo);

      // Get updated status
      const updatedStatus = await this.prismaRepository.proxyStatus.findUnique({
        where: { instanceId: instance.id },
      });

      return this.buildStatusDto(instance, updatedStatus, 'connected');
    } catch (error) {
      this.logger.error(`Error checking instance ${instanceName}: ${error}`);
      this.recordError(instanceName);
      return null;
    }
  }

  /**
   * Get current proxy status for an instance
   */
  public async getStatus(instanceName: string): Promise<ProxyStatusDto | null> {
    try {
      const instance = await this.prismaRepository.instance.findUnique({
        where: { name: instanceName },
        include: { Proxy: true, ProxyStatus: true },
      });

      if (!instance) {
        return null;
      }

      if (!instance.Proxy?.enabled) {
        return this.buildStatusDto(instance, null, 'disabled');
      }

      if (!instance.ProxyStatus) {
        return this.buildStatusDto(instance, null, 'disconnected');
      }

      // Determine connection status based on last check
      const lastCheck = instance.ProxyStatus.lastCheck;
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const status = lastCheck && lastCheck > fiveMinutesAgo ? 'connected' : 'disconnected';

      return this.buildStatusDto(instance, instance.ProxyStatus, status);
    } catch (error) {
      this.logger.error(`Error getting status for ${instanceName}: ${error}`);
      return null;
    }
  }

  /**
   * Get proxy history for an instance
   */
  public async getHistory(
    instanceName: string,
    days: number = this.RETENTION_DAYS,
    limit?: number,
  ): Promise<ProxyHistoryDto[]> {
    try {
      const instance = await this.prismaRepository.instance.findUnique({
        where: { name: instanceName },
        include: { ProxyStatus: true },
      });

      if (!instance?.ProxyStatus) {
        return [];
      }

      const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const history = await this.prismaRepository.proxyHistory.findMany({
        where: {
          proxyStatusId: instance.ProxyStatus.id,
          createdAt: { gte: sinceDate },
        },
        orderBy: { connectedAt: 'desc' },
        take: limit,
      });

      return history.map((h) => this.buildHistoryDto(h));
    } catch (error) {
      this.logger.error(`Error getting history for ${instanceName}: ${error}`);
      return [];
    }
  }

  /**
   * Get dashboard data for all instances with proxy
   */
  public async getDashboard(): Promise<ProxyDashboardItemDto[]> {
    try {
      const instances = await this.prismaRepository.instance.findMany({
        where: {
          Proxy: {
            isNot: null,
          },
        },
        include: {
          Proxy: true,
          ProxyStatus: true,
        },
      });

      return instances.map((instance) => {
        const proxyEnabled = instance.Proxy?.enabled ?? false;

        let status: 'connected' | 'disconnected' | 'error' | 'disabled' = 'disabled';
        if (proxyEnabled) {
          if (instance.ProxyStatus?.lastCheck) {
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            status = instance.ProxyStatus.lastCheck > fiveMinutesAgo ? 'connected' : 'disconnected';
          } else {
            status = 'disconnected';
          }
        }

        return {
          instanceId: instance.id,
          instanceName: instance.name,
          currentIp: instance.ProxyStatus?.currentIp ?? null,
          city: instance.ProxyStatus?.city ?? null,
          country: instance.ProxyStatus?.country ?? null,
          countryCode: instance.ProxyStatus?.countryCode ?? null,
          connectedSince: instance.ProxyStatus?.connectedSince ?? null,
          totalIpChanges: instance.ProxyStatus?.totalIpChanges ?? 0,
          lastIpChange: instance.ProxyStatus?.lastIpChange ?? null,
          lastCheck: instance.ProxyStatus?.lastCheck ?? null,
          connectionStatus: status,
          proxyEnabled,
        };
      });
    } catch (error) {
      this.logger.error(`Error getting dashboard data: ${error}`);
      return [];
    }
  }

  /**
   * Force refresh proxy status for an instance
   */
  public async refreshStatus(instanceName: string): Promise<ProxyStatusDto | null> {
    return this.checkInstance(instanceName);
  }

  /**
   * Fetch location info from Oxylabs via proxy
   */
  private async fetchProxyInfo(proxy: Proxy): Promise<OxylabsLocationResponse | null> {
    try {
      const agent = makeProxyAgent({
        host: proxy.host,
        port: proxy.port,
        protocol: proxy.protocol,
        username: proxy.username,
        password: proxy.password,
      });

      const response = await axios.get<OxylabsLocationResponse>('https://ip.oxylabs.io/location', {
        httpsAgent: agent,
        timeout: this.REQUEST_TIMEOUT,
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(`Oxylabs fetch error: ${error.message}`);
      } else {
        this.logger.error(`Unexpected error fetching proxy info: ${error}`);
      }
      return null;
    }
  }

  /**
   * Extract location data from Oxylabs response providers
   * Priority: dbip > ip2location > maxmind > ipinfo
   */
  private extractLocationFromOxylabs(data: OxylabsLocationResponse): ExtractedLocation {
    const providerNames = ['dbip', 'ip2location', 'maxmind', 'ipinfo'] as const;

    let city: string | null = null;
    let country: string | null = null;

    for (const providerName of providerNames) {
      const provider = data.providers[providerName];
      if (provider) {
        if (!city && provider.city) city = provider.city;
        if (!country && provider.country) country = provider.country;
        if (city && country) break;
      }
    }

    return {
      ip: data.ip,
      city,
      country,
      countryCode: country, // Oxylabs returns country code (IT, US, etc.) not full name
    };
  }

  /**
   * Update proxy status in database, detect IP changes
   */
  private async updateProxyStatus(
    instanceId: string,
    existingStatus: ProxyStatus | null,
    newInfo: OxylabsLocationResponse,
  ): Promise<void> {
    const now = new Date();

    // Extract location data from providers
    const location = this.extractLocationFromOxylabs(newInfo);

    if (!existingStatus) {
      // First time - create status and history record
      const status = await this.prismaRepository.proxyStatus.create({
        data: {
          instanceId,
          currentIp: location.ip,
          city: location.city,
          country: location.country,
          countryCode: location.countryCode,
          connectedSince: now,
          totalIpChanges: 0,
          lastCheck: now,
        },
      });

      // Create first history record
      await this.prismaRepository.proxyHistory.create({
        data: {
          proxyStatusId: status.id,
          ip: location.ip,
          city: location.city,
          country: location.country,
          countryCode: location.countryCode,
          connectedAt: now,
        },
      });

      this.logger.info(
        `Created initial proxy status for instance ${instanceId} - IP: ${location.ip}, Location: ${location.city}, ${location.countryCode}`,
      );
      return;
    }

    // Check if IP changed
    if (existingStatus.currentIp !== location.ip) {
      // IP changed - update history and increment counter
      this.logger.info(`IP change detected for instance ${instanceId}: ${existingStatus.currentIp} -> ${location.ip}`);

      // Close previous history record
      await this.prismaRepository.proxyHistory.updateMany({
        where: {
          proxyStatusId: existingStatus.id,
          disconnectedAt: null,
        },
        data: {
          disconnectedAt: now,
        },
      });

      // Create new history record
      await this.prismaRepository.proxyHistory.create({
        data: {
          proxyStatusId: existingStatus.id,
          ip: location.ip,
          city: location.city,
          country: location.country,
          countryCode: location.countryCode,
          connectedAt: now,
        },
      });

      // Update status with new IP and increment counter
      await this.prismaRepository.proxyStatus.update({
        where: { id: existingStatus.id },
        data: {
          currentIp: location.ip,
          city: location.city,
          country: location.country,
          countryCode: location.countryCode,
          totalIpChanges: { increment: 1 },
          lastIpChange: now,
          lastCheck: now,
          connectedSince: now, // Reset connected time on IP change
        },
      });
    } else {
      // Same IP - just update lastCheck
      await this.prismaRepository.proxyStatus.update({
        where: { id: existingStatus.id },
        data: {
          lastCheck: now,
          // Update location in case it changed (same IP but different geo data)
          city: location.city ?? existingStatus.city,
          country: location.country ?? existingStatus.country,
          countryCode: location.countryCode ?? existingStatus.countryCode,
        },
      });
    }
  }

  /**
   * Cleanup old history records (retention policy)
   */
  private async cleanupOldRecords(): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const result = await this.prismaRepository.proxyHistory.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });

    this.logger.info(`Cleaned up ${result.count} old proxy history records`);
  }

  /**
   * Build ProxyStatusDto from database entities
   */
  private buildStatusDto(
    instance: { id: string; name: string },
    status: ProxyStatus | null,
    connectionStatus: 'connected' | 'disconnected' | 'error' | 'disabled',
    errorMessage?: string,
  ): ProxyStatusDto {
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      currentIp: status?.currentIp ?? null,
      city: status?.city ?? null,
      country: status?.country ?? null,
      countryCode: status?.countryCode ?? null,
      connectedSince: status?.connectedSince ?? null,
      totalIpChanges: status?.totalIpChanges ?? 0,
      lastIpChange: status?.lastIpChange ?? null,
      lastCheck: status?.lastCheck ?? null,
      connectionStatus,
      errorMessage,
    };
  }

  /**
   * Build ProxyHistoryDto from database entity
   */
  private buildHistoryDto(history: ProxyHistory): ProxyHistoryDto {
    return {
      id: history.id,
      ip: history.ip,
      city: history.city,
      country: history.country,
      countryCode: history.countryCode,
      connectedAt: history.connectedAt,
      disconnectedAt: history.disconnectedAt,
    };
  }

  // Circuit breaker methods
  private shouldSkipInstance(instanceName: string): boolean {
    const errorCount = this.errorCounts.get(instanceName) ?? 0;
    return errorCount >= this.MAX_CONSECUTIVE_ERRORS;
  }

  private recordError(instanceName: string): void {
    const current = this.errorCounts.get(instanceName) ?? 0;
    this.errorCounts.set(instanceName, current + 1);
  }

  private clearError(instanceName: string): void {
    this.errorCounts.delete(instanceName);
  }
}
