/**
 * Health Monitor Service
 *
 * Provides health monitoring data for WhatsApp instances.
 * Part of the "Defense in Depth" monitoring layer.
 */

import {
  CircuitBreakerStatusDto,
  HealthDashboardDto,
  HealthEventDto,
  InstanceHealthDto,
  SystemHealthDto,
  WatchdogMetricsDto,
} from '@api/dto/health-monitor.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import { CircuitBreakerRegistry } from '@utils/circuit-breaker';

import { WAMonitoringService } from './monitor.service';

export class HealthMonitorService {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly prismaRepository: PrismaRepository,
  ) {}

  private readonly logger = new Logger('HealthMonitorService');
  private readonly startTime = Date.now();

  /**
   * Get complete dashboard data
   */
  public async getDashboard(): Promise<HealthDashboardDto> {
    const [system, instances, recentEvents, watchdogMetrics] = await Promise.all([
      this.getSystemHealth(),
      this.getAllInstancesHealth(),
      this.getRecentEvents(20),
      this.getWatchdogMetrics(),
    ]);

    return {
      system,
      instances,
      recentEvents,
      watchdogMetrics,
    };
  }

  /**
   * Get overall system health
   */
  public async getSystemHealth(): Promise<SystemHealthDto> {
    try {
      const instances = await this.prismaRepository.instance.findMany({
        include: {
          WatchdogHeartbeat: true,
        },
      });

      let connectedInstances = 0;
      let connectingInstances = 0;
      let closedInstances = 0;
      let stuckInstances = 0;
      let circuitBreakerOpen = 0;
      let totalHealthScore = 0;
      let lastCheck: Date | null = null;

      const now = Date.now();
      const stuckThreshold = 120000; // 2 minutes

      for (const instance of instances) {
        // Count by connection status
        switch (instance.connectionStatus) {
          case 'open':
            connectedInstances++;
            break;
          case 'connecting':
            connectingInstances++;
            break;
          case 'close':
            closedInstances++;
            break;
        }

        // Check for stuck instances
        const heartbeat = instance.WatchdogHeartbeat;
        if (heartbeat) {
          if (heartbeat.stuckSince && now - heartbeat.stuckSince.getTime() > stuckThreshold) {
            stuckInstances++;
          }
          if (heartbeat.circuitState === 'OPEN') {
            circuitBreakerOpen++;
          }
          if (!lastCheck || heartbeat.lastHeartbeat > lastCheck) {
            lastCheck = heartbeat.lastHeartbeat;
          }
        }

        // Calculate health score
        totalHealthScore += this.calculateInstanceHealthScore(instance, heartbeat);
      }

      const totalInstances = instances.length;
      const averageHealthScore = totalInstances > 0 ? Math.round(totalHealthScore / totalInstances) : 100;

      // Check watchdog status
      const watchdogStatus = await this.checkWatchdogStatus();

      return {
        totalInstances,
        connectedInstances,
        connectingInstances,
        closedInstances,
        stuckInstances,
        circuitBreakerOpen,
        averageHealthScore,
        watchdogStatus,
        lastCheck,
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
      };
    } catch (error) {
      this.logger.error(`Error getting system health: ${error}`);
      throw error;
    }
  }

  /**
   * Get health data for all instances
   */
  public async getAllInstancesHealth(): Promise<InstanceHealthDto[]> {
    try {
      const instances = await this.prismaRepository.instance.findMany({
        include: {
          WatchdogHeartbeat: true,
        },
      });

      return instances.map((instance) => this.mapInstanceToHealthDto(instance, instance.WatchdogHeartbeat));
    } catch (error) {
      this.logger.error(`Error getting instances health: ${error}`);
      throw error;
    }
  }

  /**
   * Get health data for a specific instance
   */
  public async getInstanceHealth(instanceName: string): Promise<InstanceHealthDto | null> {
    try {
      const instance = await this.prismaRepository.instance.findUnique({
        where: { name: instanceName },
        include: {
          WatchdogHeartbeat: true,
        },
      });

      if (!instance) {
        return null;
      }

      return this.mapInstanceToHealthDto(instance, instance.WatchdogHeartbeat);
    } catch (error) {
      this.logger.error(`Error getting instance health: ${error}`);
      throw error;
    }
  }

  /**
   * Get recent health events
   */
  public async getRecentEvents(limit: number = 50, instanceName?: string): Promise<HealthEventDto[]> {
    try {
      const where: Record<string, unknown> = {};

      if (instanceName) {
        const instance = await this.prismaRepository.instance.findUnique({
          where: { name: instanceName },
        });
        if (instance) {
          where.instanceId = instance.id;
        }
      }

      const events = await this.prismaRepository.healthEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          Instance: {
            select: { name: true },
          },
        },
      });

      return events.map((event) => ({
        id: event.id,
        instanceId: event.instanceId,
        instanceName: event.Instance.name,
        eventType: event.eventType,
        severity: event.severity as 'info' | 'warn' | 'critical',
        message: event.message,
        details: event.details as Record<string, unknown> | null,
        createdAt: event.createdAt,
      }));
    } catch (error) {
      this.logger.error(`Error getting recent events: ${error}`);
      throw error;
    }
  }

  /**
   * Get events for a specific instance
   */
  public async getInstanceEvents(
    instanceName: string,
    days: number = 7,
    limit: number = 100,
  ): Promise<HealthEventDto[]> {
    try {
      const instance = await this.prismaRepository.instance.findUnique({
        where: { name: instanceName },
      });

      if (!instance) {
        return [];
      }

      const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const events = await this.prismaRepository.healthEvent.findMany({
        where: {
          instanceId: instance.id,
          createdAt: { gte: sinceDate },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return events.map((event) => ({
        id: event.id,
        instanceId: event.instanceId,
        instanceName: instanceName,
        eventType: event.eventType,
        severity: event.severity as 'info' | 'warn' | 'critical',
        message: event.message,
        details: event.details as Record<string, unknown> | null,
        createdAt: event.createdAt,
      }));
    } catch (error) {
      this.logger.error(`Error getting instance events: ${error}`);
      throw error;
    }
  }

  /**
   * Get circuit breaker status for all instances
   */
  public getCircuitBreakerStatus(): CircuitBreakerStatusDto[] {
    const registry = CircuitBreakerRegistry.getInstance();
    const allStatus = registry.getAllStatus();

    const result: CircuitBreakerStatusDto[] = [];
    for (const [instanceName, status] of allStatus) {
      result.push({
        instanceName,
        state: status.state as 'CLOSED' | 'OPEN' | 'HALF_OPEN',
        failureCount: status.failureCount,
        successCount: status.successCount,
        lastStateChange: status.lastStateChange,
        timeInCurrentState: status.timeInCurrentState,
        config: {
          failureThreshold: status.config.failureThreshold,
          successThreshold: status.config.successThreshold,
          resetTimeout: status.config.resetTimeout,
        },
      });
    }

    return result;
  }

  /**
   * Reset circuit breaker for an instance
   */
  public resetCircuitBreaker(instanceName: string): boolean {
    const registry = CircuitBreakerRegistry.getInstance();
    const breaker = registry.getBreaker(instanceName);
    if (breaker) {
      breaker.reset();
      this.logger.info(`Circuit breaker reset for ${instanceName}`);
      return true;
    }
    return false;
  }

  /**
   * Reset all circuit breakers
   */
  public resetAllCircuitBreakers(): void {
    const registry = CircuitBreakerRegistry.getInstance();
    registry.resetAll();
    this.logger.info('All circuit breakers reset');
  }

  /**
   * Clean up old health events
   */
  public async cleanupOldEvents(retentionDays: number = 7): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      const result = await this.prismaRepository.healthEvent.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
        },
      });

      this.logger.info(`Cleaned up ${result.count} old health events`);
      return result.count;
    } catch (error) {
      this.logger.error(`Error cleaning up old events: ${error}`);
      throw error;
    }
  }

  /**
   * Get watchdog-specific metrics
   */
  public async getWatchdogMetrics(): Promise<WatchdogMetricsDto> {
    try {
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Get most recent heartbeat to determine watchdog status
      const latestHeartbeat = await this.prismaRepository.watchdogHeartbeat.findFirst({
        orderBy: { lastHeartbeat: 'desc' },
      });

      // Get oldest heartbeat to calculate total checks (estimated)
      const oldestHeartbeat = await this.prismaRepository.watchdogHeartbeat.findFirst({
        orderBy: { createdAt: 'asc' },
      });

      // Determine watchdog status
      let status: 'running' | 'stopped' | 'unknown' = 'unknown';
      let uptime = 0;
      let lastCheck: Date | null = null;

      if (latestHeartbeat) {
        const heartbeatAge = now.getTime() - latestHeartbeat.lastHeartbeat.getTime();
        status = heartbeatAge < 120000 ? 'running' : 'stopped';
        lastCheck = latestHeartbeat.lastHeartbeat;

        // Calculate uptime from oldest heartbeat
        if (oldestHeartbeat) {
          uptime = Math.floor((now.getTime() - oldestHeartbeat.createdAt.getTime()) / 1000);
        }
      }

      // Estimate total checks (one check every 60 seconds)
      const checkInterval = 60; // seconds
      const totalChecks = uptime > 0 ? Math.floor(uptime / checkInterval) : 0;

      // Count recovery events
      const [recoveriesTotal, recoveriesToday, recoveriesThisWeek, criticalRecoveries] = await Promise.all([
        // Total recoveries all time
        this.prismaRepository.healthEvent.count({
          where: { eventType: 'watchdog_recovery' },
        }),
        // Recoveries today
        this.prismaRepository.healthEvent.count({
          where: {
            eventType: 'watchdog_recovery',
            createdAt: { gte: todayStart },
          },
        }),
        // Recoveries this week
        this.prismaRepository.healthEvent.count({
          where: {
            eventType: 'watchdog_recovery',
            createdAt: { gte: weekAgo },
          },
        }),
        // Critical (failed) recoveries - severity 'critical' means > 3 attempts
        this.prismaRepository.healthEvent.count({
          where: {
            eventType: 'watchdog_recovery',
            severity: 'critical',
          },
        }),
      ]);

      // Calculate success rate
      // Successful = total - critical (critical means multiple failed attempts)
      const successfulRecoveries = Math.max(0, recoveriesTotal - criticalRecoveries);
      const failedRecoveries = criticalRecoveries;
      const successRate = recoveriesTotal > 0 ? Math.round((successfulRecoveries / recoveriesTotal) * 100) : 100;

      return {
        status,
        uptime,
        lastCheck,
        totalChecks,
        recoveriesTotal,
        recoveriesToday,
        recoveriesThisWeek,
        successfulRecoveries,
        failedRecoveries,
        successRate,
      };
    } catch (error) {
      this.logger.error(`Error getting watchdog metrics: ${error}`);
      // Return default metrics on error
      return {
        status: 'unknown',
        uptime: 0,
        lastCheck: null,
        totalChecks: 0,
        recoveriesTotal: 0,
        recoveriesToday: 0,
        recoveriesThisWeek: 0,
        successfulRecoveries: 0,
        failedRecoveries: 0,
        successRate: 100,
      };
    }
  }

  // ==========================================
  // PRIVATE METHODS
  // ==========================================

  /**
   * Map instance data to HealthDto
   */
  private mapInstanceToHealthDto(
    instance: {
      id: string;
      name: string;
      connectionStatus: string;
    },
    heartbeat: {
      lastHeartbeat: Date;
      state: string;
      stuckSince: Date | null;
      recoveryAttempts: number;
      circuitState: string | null;
      lastRecovery: Date | null;
      processId: number;
    } | null,
  ): InstanceHealthDto {
    const issues: string[] = [];
    const now = Date.now();

    // Detect issues
    if (heartbeat) {
      const heartbeatAge = now - heartbeat.lastHeartbeat.getTime();
      if (heartbeatAge > 90000) {
        issues.push(`No heartbeat for ${Math.round(heartbeatAge / 1000)}s`);
      }

      if (heartbeat.stuckSince) {
        const stuckDuration = now - heartbeat.stuckSince.getTime();
        if (stuckDuration > 60000) {
          issues.push(`Stuck in '${heartbeat.state}' for ${Math.round(stuckDuration / 1000)}s`);
        }
      }

      if (heartbeat.circuitState === 'OPEN') {
        issues.push('Circuit breaker is OPEN');
      }

      if (heartbeat.recoveryAttempts > 3) {
        issues.push(`${heartbeat.recoveryAttempts} recovery attempts`);
      }
    } else {
      issues.push('No heartbeat data');
    }

    return {
      instanceId: instance.id,
      instanceName: instance.name,
      connectionStatus: instance.connectionStatus,
      state: heartbeat?.state || 'unknown',
      lastHeartbeat: heartbeat?.lastHeartbeat || null,
      stuckSince: heartbeat?.stuckSince || null,
      recoveryAttempts: heartbeat?.recoveryAttempts || 0,
      circuitState: heartbeat?.circuitState || null,
      lastRecovery: heartbeat?.lastRecovery || null,
      processId: heartbeat?.processId || null,
      healthScore: this.calculateInstanceHealthScore(instance, heartbeat),
      issues,
    };
  }

  /**
   * Calculate health score for an instance (0-100)
   */
  private calculateInstanceHealthScore(
    instance: { connectionStatus: string },
    heartbeat: {
      lastHeartbeat: Date;
      state: string;
      stuckSince: Date | null;
      recoveryAttempts: number;
      circuitState: string | null;
    } | null,
  ): number {
    let score = 100;
    const now = Date.now();

    // Connection status penalties
    if (instance.connectionStatus === 'close') {
      score -= 30;
    } else if (instance.connectionStatus === 'connecting') {
      score -= 15;
    }

    if (!heartbeat) {
      return Math.max(0, score - 20);
    }

    // Heartbeat age penalty
    const heartbeatAge = now - heartbeat.lastHeartbeat.getTime();
    if (heartbeatAge > 90000) {
      score -= 40;
    } else if (heartbeatAge > 60000) {
      score -= 20;
    } else if (heartbeatAge > 30000) {
      score -= 10;
    }

    // Stuck state penalty
    if (heartbeat.stuckSince) {
      const stuckDuration = now - heartbeat.stuckSince.getTime();
      if (stuckDuration > 120000) {
        score -= 30;
      } else if (stuckDuration > 60000) {
        score -= 15;
      }
    }

    // Circuit breaker penalty
    if (heartbeat.circuitState === 'OPEN') {
      score -= 25;
    } else if (heartbeat.circuitState === 'HALF_OPEN') {
      score -= 10;
    }

    // Recovery attempts penalty
    if (heartbeat.recoveryAttempts > 5) {
      score -= 20;
    } else if (heartbeat.recoveryAttempts > 3) {
      score -= 10;
    } else if (heartbeat.recoveryAttempts > 0) {
      score -= 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Check if watchdog process is running
   */
  private async checkWatchdogStatus(): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      // Check if there are recent heartbeats (within last 2 minutes)
      const recentHeartbeat = await this.prismaRepository.watchdogHeartbeat.findFirst({
        where: {
          lastHeartbeat: {
            gte: new Date(Date.now() - 120000),
          },
        },
      });

      if (recentHeartbeat) {
        return 'running';
      }

      // Check if there are any heartbeats at all
      const anyHeartbeat = await this.prismaRepository.watchdogHeartbeat.findFirst();
      if (anyHeartbeat) {
        return 'stopped';
      }

      return 'unknown';
    } catch (error) {
      this.logger.error(`Error checking watchdog status: ${error}`);
      return 'unknown';
    }
  }
}
