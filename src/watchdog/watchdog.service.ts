/**
 * External Watchdog Service
 *
 * Runs as a SEPARATE PM2 process to monitor WhatsApp instances.
 * Can detect and recover from stuck instances even if main process is frozen.
 *
 * Part of the "Defense in Depth" architecture - Layer 3 (Last Line of Defense)
 *
 * Detection methods:
 * 1. Heartbeat timeout - No heartbeat update for 90+ seconds
 * 2. Stuck in connecting - In 'connecting' state for 120+ seconds
 * 3. Circuit breaker stuck - Circuit open for too long
 *
 * Recovery actions (escalating):
 * 1. API restart - Gentle restart via REST API
 * 2. Force flag in DB - Set flags to trigger internal restart
 * 3. PM2 restart - Nuclear option, restart entire process
 */

import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { exec } from 'child_process';

// ✅ FIX 1.4: Timeout wrapper per query DB del watchdog
const DB_TIMEOUT_MS = 10000; // 10 secondi - più alto per il watchdog che deve essere robusto

async function withWatchdogTimeout<T>(promise: Promise<T>, operationName: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`[Watchdog] DB timeout after ${DB_TIMEOUT_MS}ms: ${operationName}`));
    }, DB_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

interface WatchdogConfig {
  checkInterval: number; // How often to check (default: 60s)
  heartbeatTimeout: number; // Max time without heartbeat (default: 90s)
  stuckConnectingTimeout: number; // Max time in 'connecting' (default: 120s)
  maxRecoveryAttempts: number; // Before escalating to PM2 restart (default: 5)
  apiBaseUrl: string; // Evolution API URL
  apiKey: string; // API key for restart calls
  pm2ProcessName: string; // PM2 process name
}

export class WatchdogService {
  private prisma: PrismaClient;
  private config: WatchdogConfig;
  private checkTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isCheckRunning = false; // ✅ FIX 3: Prevent overlapping check cycles
  private logger: Console;

  constructor(config: Partial<WatchdogConfig> = {}) {
    this.config = {
      checkInterval: config.checkInterval ?? 60000,
      heartbeatTimeout: config.heartbeatTimeout ?? 90000,
      stuckConnectingTimeout: config.stuckConnectingTimeout ?? 120000,
      maxRecoveryAttempts: config.maxRecoveryAttempts ?? 5,
      apiBaseUrl: config.apiBaseUrl ?? process.env.SERVER_URL ?? 'http://localhost:8080',
      apiKey: config.apiKey ?? process.env.AUTHENTICATION_API_KEY ?? '',
      pm2ProcessName: config.pm2ProcessName ?? 'evolution-api',
    };

    this.prisma = new PrismaClient();
    this.logger = console;
  }

  /**
   * Start the watchdog service
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // ✅ FIX 5: Timeout on $connect to prevent blocking
    await withWatchdogTimeout(this.prisma.$connect(), 'prismaConnect');
    this.log('INFO', `Watchdog started - PID: ${process.pid}`);
    this.log(
      'INFO',
      `Config: checkInterval=${this.config.checkInterval}ms, heartbeatTimeout=${this.config.heartbeatTimeout}ms`,
    );

    // Initial check
    await this.checkAllInstances();

    // Periodic checks
    this.checkTimer = setInterval(async () => {
      try {
        await this.checkAllInstances();
      } catch (error) {
        this.log('ERROR', `Check failed: ${error}`);
      }
    }, this.config.checkInterval);

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  /**
   * Stop the watchdog service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    // ✅ FIX 5: Timeout on $disconnect to prevent blocking during shutdown
    try {
      await withWatchdogTimeout(this.prisma.$disconnect(), 'prismaDisconnect');
    } catch (e) {
      this.log('WARN', `Disconnect timeout during shutdown: ${e}`);
    }
    this.log('INFO', 'Watchdog stopped');
    process.exit(0);
  }

  /**
   * ✅ FIX 2.4: Check database connectivity before performing checks
   * If DB is down, skip the cycle to avoid blocking
   */
  private async checkDatabaseHealth(): Promise<boolean> {
    try {
      await withWatchdogTimeout(this.prisma.$queryRaw`SELECT 1`, 'dbHealthCheck');
      return true;
    } catch (error) {
      this.log('ERROR', `DB health check failed: ${error}`);
      try {
        // ✅ FIX 5: Timeout on reconnection attempts
        await withWatchdogTimeout(this.prisma.$disconnect(), 'healthCheckDisconnect');
        await withWatchdogTimeout(this.prisma.$connect(), 'healthCheckReconnect');
        this.log('INFO', 'DB reconnection successful');
        return true;
      } catch (reconnectError) {
        this.log('ERROR', `DB reconnection failed: ${reconnectError}`);
        return false;
      }
    }
  }

  /**
   * Check all instances for health issues
   */
  private async checkAllInstances(): Promise<void> {
    // ✅ FIX 3: Prevent overlapping check cycles
    if (this.isCheckRunning) {
      this.log('WARN', 'Previous check still running, skipping this cycle');
      return;
    }

    this.isCheckRunning = true;
    try {
      await this._performInstanceChecks();
    } finally {
      this.isCheckRunning = false;
    }
  }

  /**
   * Internal method that performs the actual instance checks
   */
  private async _performInstanceChecks(): Promise<void> {
    // ✅ FIX 2.4: Verify DB is healthy before proceeding
    if (!(await this.checkDatabaseHealth())) {
      this.log('ERROR', 'DB unavailable, skipping check cycle');
      return;
    }

    const now = new Date();
    const heartbeatCutoff = new Date(now.getTime() - this.config.heartbeatTimeout);
    const connectingCutoff = new Date(now.getTime() - this.config.stuckConnectingTimeout);

    try {
      // ✅ FIX 1.4: Get all instances with their heartbeats (con timeout)
      const instances = await withWatchdogTimeout(
        this.prisma.instance.findMany({
          where: {
            definitiveLogout: false,
            connectionStatus: { not: 'close' },
          },
          include: {
            WatchdogHeartbeat: true,
          },
        }),
        'checkAllInstances:findMany',
      );

      this.log('DEBUG', `Checking ${instances.length} active instances`);

      for (const instance of instances) {
        const heartbeat = instance.WatchdogHeartbeat;

        // SCENARIO 1: No heartbeat record at all
        if (!heartbeat) {
          this.log('WARN', `Instance ${instance.name} has no heartbeat record`);
          // Don't restart - might be newly created instance
          continue;
        }

        // SCENARIO 2: Heartbeat too old (process frozen or dead)
        if (heartbeat.lastHeartbeat < heartbeatCutoff) {
          const stuckDuration = now.getTime() - heartbeat.lastHeartbeat.getTime();
          this.log('ERROR', `Instance ${instance.name} - No heartbeat for ${Math.round(stuckDuration / 1000)}s`);
          await this.handleStuckInstance(instance.id, instance.name, 'stale_heartbeat', heartbeat.recoveryAttempts);
          continue;
        }

        // SCENARIO 3: Stuck in 'connecting' state
        if (heartbeat.state === 'connecting') {
          if (!heartbeat.stuckSince) {
            // ✅ FIX 1.4: Mark when we first detected connecting state (con timeout)
            await withWatchdogTimeout(
              this.prisma.watchdogHeartbeat.update({
                where: { instanceId: instance.id },
                data: { stuckSince: now },
              }),
              'markConnectingStuck',
            );
            this.log('INFO', `Instance ${instance.name} entered 'connecting' state, starting timer`);
          } else if (heartbeat.stuckSince < connectingCutoff) {
            const stuckDuration = now.getTime() - heartbeat.stuckSince.getTime();
            this.log(
              'ERROR',
              `Instance ${instance.name} - Stuck in connecting for ${Math.round(stuckDuration / 1000)}s`,
            );
            await this.handleStuckInstance(instance.id, instance.name, 'stuck_connecting', heartbeat.recoveryAttempts);
          }
        } else {
          // Clear stuckSince if not in connecting state
          if (heartbeat.stuckSince) {
            // ✅ FIX 1.4: Clear stuck timer (con timeout)
            await withWatchdogTimeout(
              this.prisma.watchdogHeartbeat.update({
                where: { instanceId: instance.id },
                data: { stuckSince: null, recoveryAttempts: 0 },
              }),
              'clearStuckTimer',
            );
            this.log('INFO', `Instance ${instance.name} recovered, clearing stuck timer`);
          }
        }

        // SCENARIO 4: Circuit breaker stuck in OPEN
        if (heartbeat.circuitState === 'OPEN') {
          this.log('WARN', `Instance ${instance.name} - Circuit breaker is OPEN`);
          // Log but don't restart - circuit breaker will handle recovery
        }
      }

      // Check main process health
      await this.checkMainProcessHealth();
    } catch (error) {
      this.log('ERROR', `Failed to check instances: ${error}`);
    }
  }

  /**
   * Handle a stuck instance with escalating recovery actions
   */
  private async handleStuckInstance(
    instanceId: string,
    instanceName: string,
    reason: string,
    _currentAttempts: number, // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<void> {
    // ✅ FIX 4: Use atomic increment to prevent race conditions
    const updated = await withWatchdogTimeout(
      this.prisma.watchdogHeartbeat.update({
        where: { instanceId },
        data: {
          recoveryAttempts: { increment: 1 }, // ATOMIC increment
          lastRecovery: new Date(),
        },
      }),
      'updateRecoveryAttempts',
    );
    const attempts = updated.recoveryAttempts;

    // Log the recovery attempt
    await this.logRecoveryEvent(instanceId, reason, attempts);

    // ✅ FIX 2.2: Exponential backoff - evita recovery troppo rapidi che non aiutano
    const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 30000); // 1s, 2s, 4s, 8s, 16s, max 30s
    this.log('INFO', `Instance ${instanceName} - Applying backoff delay of ${backoffMs}ms before attempt ${attempts}`);
    await this.sleep(backoffMs);

    // Escalating recovery actions
    if (attempts <= 2) {
      // LEVEL 1: API-based restart (gentlest)
      this.log('INFO', `Instance ${instanceName} - Attempting API restart (attempt ${attempts})`);
      await this.restartViaApi(instanceName);
    } else if (attempts <= this.config.maxRecoveryAttempts) {
      // LEVEL 2: Force restart via database flag
      this.log('WARN', `Instance ${instanceName} - Attempting force restart via DB (attempt ${attempts})`);
      await this.forceRestartViaDb(instanceId, instanceName);
    } else {
      // LEVEL 3: Nuclear option - restart entire PM2 process
      this.log(
        'ERROR',
        `Instance ${instanceName} - Max attempts (${this.config.maxRecoveryAttempts}) exceeded, restarting PM2 process`,
      );
      await this.restartPm2Process();
    }
  }

  /**
   * ✅ FIX 2.2: Sleep utility for exponential backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Restart instance via API
   */
  private async restartViaApi(instanceName: string): Promise<void> {
    try {
      const response = await axios.post(
        `${this.config.apiBaseUrl}/instance/restart/${instanceName}`,
        {},
        {
          headers: { apikey: this.config.apiKey },
          timeout: 30000,
        },
      );
      this.log('INFO', `API restart for ${instanceName}: status ${response.status}`);
    } catch (error: any) {
      this.log('ERROR', `API restart failed for ${instanceName}: ${error.message}`);
    }
  }

  /**
   * Force restart by updating database flags
   */
  private async forceRestartViaDb(instanceId: string, instanceName: string): Promise<void> {
    try {
      // ✅ FIX 1.4: Reset the instance connection status to force reconnection (con timeout)
      await withWatchdogTimeout(
        this.prisma.instance.update({
          where: { id: instanceId },
          data: {
            connectionStatus: 'close',
          },
        }),
        'forceRestartViaDb',
      );
      this.log('INFO', `Force restart flag set for ${instanceName}`);
    } catch (error: any) {
      this.log('ERROR', `Force restart via DB failed for ${instanceName}: ${error.message}`);
    }
  }

  /**
   * Restart entire PM2 process (nuclear option)
   * ✅ FIX 5: Aggiunto timeout 30s per evitare blocco indefinito
   */
  private async restartPm2Process(): Promise<void> {
    return new Promise((resolve) => {
      const PM2_RESTART_TIMEOUT = 30000; // 30 secondi

      // Timeout per prevenire blocco indefinito
      const timeout = setTimeout(() => {
        this.log('ERROR', 'PM2 restart timeout after 30s');
        resolve();
      }, PM2_RESTART_TIMEOUT);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      exec(`pm2 restart ${this.config.pm2ProcessName}`, (error, stdout, _stderr) => {
        clearTimeout(timeout);
        if (error) {
          this.log('ERROR', `PM2 restart failed: ${error.message}`);
        } else {
          this.log('INFO', `PM2 restart completed: ${stdout}`);
        }
        resolve();
      });
    });
  }

  /**
   * Check if main API process is responding
   */
  private async checkMainProcessHealth(): Promise<void> {
    try {
      const response = await axios.get(`${this.config.apiBaseUrl}/`, {
        timeout: 10000,
      });
      if (response.status !== 200) {
        this.log('WARN', `Main API returned status ${response.status}`);
      }
    } catch (error: any) {
      this.log('ERROR', `Main API health check failed: ${error.message}`);
      // Don't restart immediately - could be temporary issue
    }
  }

  /**
   * Log a recovery event to the database
   */
  private async logRecoveryEvent(instanceId: string, reason: string, attempt: number): Promise<void> {
    try {
      // ✅ FIX 1.4: Log recovery event (con timeout)
      await withWatchdogTimeout(
        this.prisma.healthEvent.create({
          data: {
            instanceId,
            eventType: 'watchdog_recovery',
            severity: attempt > 3 ? 'critical' : 'warn',
            message: `Watchdog recovery attempt ${attempt}: ${reason}`,
            details: { reason, attempt, timestamp: new Date().toISOString() },
          },
        }),
        'logRecoveryEvent',
      );
    } catch {
      // Silently fail - don't block recovery for logging
    }
  }

  /**
   * Simple logging with timestamp
   */
  private log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [Watchdog] [${level}] ${message}`;

    switch (level) {
      case 'ERROR':
        this.logger.error(formatted);
        break;
      case 'WARN':
        this.logger.warn(formatted);
        break;
      case 'DEBUG':
        if (process.env.WATCHDOG_DEBUG === 'true') {
          this.logger.log(formatted);
        }
        break;
      default:
        this.logger.log(formatted);
    }
  }
}
