import { InstanceDto } from '@api/dto/instance.dto';
import { ProxyDashboardItemDto, ProxyHistoryDto, ProxyStatusDto } from '@api/dto/proxy-monitor.dto';
import { ProxyMonitorService } from '@api/services/proxy-monitor.service';
import { Logger } from '@config/logger.config';
import { NotFoundException } from '@exceptions';

export class ProxyMonitorController {
  constructor(private readonly proxyMonitorService: ProxyMonitorService) {}

  private readonly logger = new Logger('ProxyMonitorController');

  /**
   * Get proxy status for a single instance
   */
  public async getStatus(instance: InstanceDto): Promise<ProxyStatusDto> {
    const status = await this.proxyMonitorService.getStatus(instance.instanceName);

    if (!status) {
      throw new NotFoundException(`Instance "${instance.instanceName}" not found or has no proxy configured`);
    }

    return status;
  }

  /**
   * Get proxy history for a single instance (last 10 IPs)
   */
  public async getHistory(instance: InstanceDto): Promise<ProxyHistoryDto[]> {
    return this.proxyMonitorService.getHistory(instance.instanceName, 7, 10);
  }

  /**
   * Force refresh proxy status for a single instance
   */
  public async refreshStatus(instance: InstanceDto): Promise<ProxyStatusDto> {
    const status = await this.proxyMonitorService.refreshStatus(instance.instanceName);

    if (!status) {
      throw new NotFoundException(`Instance "${instance.instanceName}" not found or has no proxy configured`);
    }

    return status;
  }

  /**
   * Get dashboard data for all instances with proxy
   */
  public async getDashboard(): Promise<ProxyDashboardItemDto[]> {
    return this.proxyMonitorService.getDashboard();
  }
}
