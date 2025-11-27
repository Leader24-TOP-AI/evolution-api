/**
 * Health Monitor DTOs
 *
 * Data Transfer Objects for the Health Monitor API
 */

export interface InstanceHealthDto {
  instanceId: string;
  instanceName: string;
  connectionStatus: string;
  state: string;
  lastHeartbeat: Date | null;
  stuckSince: Date | null;
  recoveryAttempts: number;
  circuitState: string | null;
  lastRecovery: Date | null;
  processId: number | null;
  healthScore: number; // 0-100, calculated from various factors
  issues: string[];
}

export interface HealthEventDto {
  id: string;
  instanceId: string;
  instanceName: string;
  eventType: string;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SystemHealthDto {
  totalInstances: number;
  connectedInstances: number;
  connectingInstances: number;
  closedInstances: number;
  stuckInstances: number;
  circuitBreakerOpen: number;
  averageHealthScore: number;
  watchdogStatus: 'running' | 'stopped' | 'unknown';
  lastCheck: Date | null;
  uptime: number; // seconds
}

export interface HealthDashboardDto {
  system: SystemHealthDto;
  instances: InstanceHealthDto[];
  recentEvents: HealthEventDto[];
  watchdogMetrics: WatchdogMetricsDto;
}

export interface CircuitBreakerStatusDto {
  instanceName: string;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  successCount: number;
  lastStateChange: Date;
  timeInCurrentState: number;
  config: {
    failureThreshold: number;
    successThreshold: number;
    resetTimeout: number;
  };
}

export interface WatchdogMetricsDto {
  status: 'running' | 'stopped' | 'unknown';
  uptime: number; // seconds since watchdog started (from lastHeartbeat)
  lastCheck: Date | null;
  totalChecks: number; // total watchdog_check events
  recoveriesTotal: number; // all-time recovery attempts
  recoveriesToday: number; // recovery attempts today
  recoveriesThisWeek: number; // recovery attempts last 7 days
  successfulRecoveries: number; // recoveries that succeeded
  failedRecoveries: number; // recoveries that failed
  successRate: number; // percentage 0-100
}
