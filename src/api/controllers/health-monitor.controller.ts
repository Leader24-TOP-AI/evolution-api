/**
 * Health Monitor Controller
 *
 * Handles HTTP requests for health monitoring endpoints.
 */

import {
  CircuitBreakerStatusDto,
  HealthDashboardDto,
  HealthEventDto,
  InstanceHealthDto,
  SystemHealthDto,
} from '@api/dto/health-monitor.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { HealthMonitorService } from '@api/services/health-monitor.service';
import { Logger } from '@config/logger.config';
import { NotFoundException } from '@exceptions';

export class HealthMonitorController {
  constructor(private readonly healthMonitorService: HealthMonitorService) {}

  private readonly logger = new Logger('HealthMonitorController');

  /**
   * Get complete dashboard data
   * GET /health-monitor/dashboard
   */
  public async getDashboard(): Promise<HealthDashboardDto> {
    return this.healthMonitorService.getDashboard();
  }

  /**
   * Get system-wide health status
   * GET /health-monitor/system
   */
  public async getSystemHealth(): Promise<SystemHealthDto> {
    return this.healthMonitorService.getSystemHealth();
  }

  /**
   * Get all instances health
   * GET /health-monitor/instances
   */
  public async getAllInstancesHealth(): Promise<InstanceHealthDto[]> {
    return this.healthMonitorService.getAllInstancesHealth();
  }

  /**
   * Get health for a specific instance
   * GET /health-monitor/instance/:instanceName
   */
  public async getInstanceHealth(instance: InstanceDto): Promise<InstanceHealthDto> {
    const health = await this.healthMonitorService.getInstanceHealth(instance.instanceName);

    if (!health) {
      throw new NotFoundException(`Instance "${instance.instanceName}" not found`);
    }

    return health;
  }

  /**
   * Get recent health events
   * GET /health-monitor/events
   */
  public async getRecentEvents(): Promise<HealthEventDto[]> {
    return this.healthMonitorService.getRecentEvents(50);
  }

  /**
   * Get events for a specific instance
   * GET /health-monitor/events/:instanceName
   */
  public async getInstanceEvents(instance: InstanceDto): Promise<HealthEventDto[]> {
    return this.healthMonitorService.getInstanceEvents(instance.instanceName);
  }

  /**
   * Get all circuit breaker statuses
   * GET /health-monitor/circuit-breakers
   */
  public getCircuitBreakerStatus(): CircuitBreakerStatusDto[] {
    return this.healthMonitorService.getCircuitBreakerStatus();
  }

  /**
   * Reset circuit breaker for an instance
   * POST /health-monitor/circuit-breaker/reset/:instanceName
   */
  public async resetCircuitBreaker(instance: InstanceDto): Promise<{ success: boolean; message: string }> {
    const success = this.healthMonitorService.resetCircuitBreaker(instance.instanceName);

    if (!success) {
      return {
        success: false,
        message: `No circuit breaker found for instance "${instance.instanceName}"`,
      };
    }

    return {
      success: true,
      message: `Circuit breaker reset for instance "${instance.instanceName}"`,
    };
  }

  /**
   * Reset all circuit breakers
   * POST /health-monitor/circuit-breakers/reset-all
   */
  public resetAllCircuitBreakers(): { success: boolean; message: string } {
    this.healthMonitorService.resetAllCircuitBreakers();
    return {
      success: true,
      message: 'All circuit breakers have been reset',
    };
  }

  /**
   * Cleanup old health events
   * POST /health-monitor/cleanup
   */
  public async cleanupOldEvents(): Promise<{ success: boolean; deletedCount: number }> {
    const deletedCount = await this.healthMonitorService.cleanupOldEvents(7);
    return {
      success: true,
      deletedCount,
    };
  }
}
