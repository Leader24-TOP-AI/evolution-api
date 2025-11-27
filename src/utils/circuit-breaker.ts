/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascade failures by tracking failures and temporarily
 * blocking operations when a threshold is exceeded.
 *
 * States:
 * - CLOSED: Normal operation, all requests pass through
 * - OPEN: Circuit tripped, all requests are rejected immediately
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 *
 * Part of the "Defense in Depth" architecture - Layer 2
 */

import { Logger } from '@config/logger.config';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Blocking all operations
  HALF_OPEN = 'HALF_OPEN', // Testing recovery
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold: number;

  /** Number of successes in HALF_OPEN to close circuit (default: 2) */
  successThreshold: number;

  /** Time in OPEN state before transitioning to HALF_OPEN (default: 60000ms) */
  resetTimeout: number;

  /** Maximum attempts allowed in HALF_OPEN state (default: 3) */
  halfOpenMaxAttempts: number;

  /** Time window for counting failures (default: 60000ms) */
  failureWindowMs: number;

  /** Name for logging purposes */
  name: string;
}

/**
 * Circuit breaker event types
 */
export type CircuitBreakerEvent =
  | 'state_change'
  | 'failure_recorded'
  | 'success_recorded'
  | 'circuit_opened'
  | 'circuit_closed'
  | 'circuit_half_open';

/**
 * Circuit breaker event callback
 */
export type CircuitBreakerEventCallback = (event: CircuitBreakerEvent, data: CircuitBreakerEventData) => void;

/**
 * Event data structure
 */
export interface CircuitBreakerEventData {
  state: CircuitState;
  previousState?: CircuitState;
  failureCount: number;
  successCount: number;
  reason?: string;
  timestamp: Date;
}

/**
 * Failure record for time-windowed counting
 */
interface FailureRecord {
  timestamp: number;
  reason?: string;
}

/**
 * Circuit Breaker - Fail-fast pattern for connection recovery
 *
 * @example
 * const breaker = new CircuitBreaker({
 *   name: 'instance-123',
 *   failureThreshold: 5,
 *   successThreshold: 2,
 *   resetTimeout: 60000,
 *   halfOpenMaxAttempts: 3,
 *   failureWindowMs: 60000
 * });
 *
 * // Before attempting operation
 * if (!breaker.canExecute()) {
 *   console.log('Circuit is open, skipping operation');
 *   return;
 * }
 *
 * try {
 *   await reconnect();
 *   breaker.recordSuccess();
 * } catch (error) {
 *   breaker.recordFailure(error.message);
 * }
 */
export class CircuitBreaker {
  private readonly logger: Logger;
  private config: CircuitBreakerConfig;

  private state: CircuitState = CircuitState.CLOSED;
  private failures: FailureRecord[] = [];
  private successCount: number = 0;
  private halfOpenAttempts: number = 0;
  private lastStateChange: number = Date.now();
  private resetTimer: NodeJS.Timeout | null = null;

  // Event callbacks
  private eventCallbacks: CircuitBreakerEventCallback[] = [];

  // Statistics
  private stats = {
    totalFailures: 0,
    totalSuccesses: 0,
    timesOpened: 0,
    lastOpenReason: null as string | null,
    lastOpenTime: null as Date | null,
  };

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      resetTimeout: config.resetTimeout ?? 60000,
      halfOpenMaxAttempts: config.halfOpenMaxAttempts ?? 3,
      failureWindowMs: config.failureWindowMs ?? 60000,
      name: config.name,
    };

    this.logger = new Logger(`CircuitBreaker:${this.config.name}`);
  }

  // ==========================================
  // CORE OPERATIONS
  // ==========================================

  /**
   * Check if operation can be executed
   *
   * @returns true if circuit allows execution
   */
  canExecute(): boolean {
    this.cleanupOldFailures();

    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if reset timeout has passed
        if (Date.now() - this.lastStateChange >= this.config.resetTimeout) {
          this.transitionTo(CircuitState.HALF_OPEN, 'reset_timeout_elapsed');
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Allow limited attempts in half-open
        if (this.halfOpenAttempts < this.config.halfOpenMaxAttempts) {
          this.halfOpenAttempts++;
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Record a successful operation
   */
  recordSuccess(): void {
    this.stats.totalSuccesses++;

    switch (this.state) {
      case CircuitState.CLOSED:
        // Reset failure count on success
        this.failures = [];
        this.emitEvent('success_recorded');
        break;

      case CircuitState.HALF_OPEN:
        this.successCount++;
        this.emitEvent('success_recorded');

        if (this.successCount >= this.config.successThreshold) {
          this.transitionTo(CircuitState.CLOSED, 'success_threshold_reached');
        }
        break;

      case CircuitState.OPEN:
        // Shouldn't happen, but log it
        this.logger.warn('Success recorded while circuit is OPEN');
        break;
    }
  }

  /**
   * Record a failed operation
   *
   * @param reason Optional reason for failure
   */
  recordFailure(reason?: string): void {
    this.stats.totalFailures++;
    this.cleanupOldFailures();

    this.failures.push({
      timestamp: Date.now(),
      reason,
    });

    this.emitEvent('failure_recorded');

    switch (this.state) {
      case CircuitState.CLOSED:
        if (this.failures.length >= this.config.failureThreshold) {
          this.tripCircuit(reason || 'failure_threshold_exceeded');
        }
        break;

      case CircuitState.HALF_OPEN:
        // Any failure in half-open immediately opens circuit
        this.tripCircuit(reason || 'failure_in_half_open');
        break;

      case CircuitState.OPEN:
        // Already open, just log
        break;
    }
  }

  /**
   * Manually trip (open) the circuit
   *
   * @param reason Reason for tripping
   */
  tripCircuit(reason: string): void {
    if (this.state === CircuitState.OPEN) {
      return; // Already open
    }

    this.stats.timesOpened++;
    this.stats.lastOpenReason = reason;
    this.stats.lastOpenTime = new Date();

    this.transitionTo(CircuitState.OPEN, reason);
    this.emitEvent('circuit_opened');

    this.logger.error(`Circuit OPENED: ${reason} (failures: ${this.failures.length})`);

    // Schedule transition to HALF_OPEN
    this.scheduleReset();
  }

  /**
   * Manually reset the circuit to CLOSED state
   */
  reset(): void {
    this.cancelReset();
    this.failures = [];
    this.successCount = 0;
    this.halfOpenAttempts = 0;
    this.transitionTo(CircuitState.CLOSED, 'manual_reset');
    this.logger.log('Circuit manually reset to CLOSED');
  }

  // ==========================================
  // STATE MANAGEMENT
  // ==========================================

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get detailed status information
   */
  getStatus(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    halfOpenAttempts: number;
    lastStateChange: Date;
    timeInCurrentState: number;
    stats: typeof this.stats;
    config: CircuitBreakerConfig;
  } {
    return {
      state: this.state,
      failureCount: this.failures.length,
      successCount: this.successCount,
      halfOpenAttempts: this.halfOpenAttempts,
      lastStateChange: new Date(this.lastStateChange),
      timeInCurrentState: Date.now() - this.lastStateChange,
      stats: { ...this.stats },
      config: { ...this.config },
    };
  }

  /**
   * Check if circuit is open
   */
  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  /**
   * Check if circuit is closed (normal operation)
   */
  isClosed(): boolean {
    return this.state === CircuitState.CLOSED;
  }

  /**
   * Check if circuit is testing recovery
   */
  isHalfOpen(): boolean {
    return this.state === CircuitState.HALF_OPEN;
  }

  // ==========================================
  // EVENT HANDLING
  // ==========================================

  /**
   * Register an event callback
   */
  onEvent(callback: CircuitBreakerEventCallback): () => void {
    this.eventCallbacks.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.eventCallbacks.indexOf(callback);
      if (index > -1) {
        this.eventCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Set callback for when circuit opens (for admin notifications)
   */
  onCircuitOpen(callback: (name: string, reason: string) => void): () => void {
    return this.onEvent((event, data) => {
      if (event === 'circuit_opened') {
        callback(this.config.name, data.reason || 'unknown');
      }
    });
  }

  // ==========================================
  // PRIVATE METHODS
  // ==========================================

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    const previousState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();

    // Reset counters on state change
    if (newState === CircuitState.CLOSED) {
      this.failures = [];
      this.successCount = 0;
      this.halfOpenAttempts = 0;
      this.cancelReset();
      this.emitEvent('circuit_closed');
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successCount = 0;
      this.halfOpenAttempts = 0;
      this.emitEvent('circuit_half_open');
    }

    this.logger.log(`State transition: ${previousState} -> ${newState} (reason: ${reason})`);

    this.emitEvent('state_change', { previousState, reason });
  }

  /**
   * Schedule transition to HALF_OPEN after reset timeout
   */
  private scheduleReset(): void {
    this.cancelReset();

    this.resetTimer = setTimeout(() => {
      if (this.state === CircuitState.OPEN) {
        this.transitionTo(CircuitState.HALF_OPEN, 'reset_timeout');
        this.logger.log('Circuit transitioned to HALF_OPEN for recovery testing');
      }
    }, this.config.resetTimeout);
  }

  /**
   * Cancel scheduled reset
   */
  private cancelReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  /**
   * Remove failures outside the time window
   */
  private cleanupOldFailures(): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    this.failures = this.failures.filter((f) => f.timestamp > cutoff);
  }

  /**
   * Emit an event to all registered callbacks
   */
  private emitEvent(event: CircuitBreakerEvent, extra?: { previousState?: CircuitState; reason?: string }): void {
    const data: CircuitBreakerEventData = {
      state: this.state,
      previousState: extra?.previousState,
      failureCount: this.failures.length,
      successCount: this.successCount,
      reason: extra?.reason,
      timestamp: new Date(),
    };

    for (const callback of this.eventCallbacks) {
      try {
        callback(event, data);
      } catch (e) {
        this.logger.error(`Error in event callback: ${e}`);
      }
    }
  }

  /**
   * Cleanup resources (call when instance is being destroyed)
   */
  destroy(): void {
    this.cancelReset();
    this.eventCallbacks = [];
    this.failures = [];
  }
}

/**
 * Global Circuit Breaker Registry
 * Tracks circuit breakers for all instances
 */
export class CircuitBreakerRegistry {
  private static instance: CircuitBreakerRegistry;
  private breakers: Map<string, CircuitBreaker> = new Map();

  private constructor() {}

  static getInstance(): CircuitBreakerRegistry {
    if (!CircuitBreakerRegistry.instance) {
      CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
    }
    return CircuitBreakerRegistry.instance;
  }

  /**
   * Get or create a circuit breaker for an instance
   */
  getBreaker(instanceName: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(instanceName);
    if (!breaker) {
      breaker = new CircuitBreaker({
        name: instanceName,
        ...config,
      });
      this.breakers.set(instanceName, breaker);
    }
    return breaker;
  }

  /**
   * Remove a circuit breaker
   */
  removeBreaker(instanceName: string): void {
    const breaker = this.breakers.get(instanceName);
    if (breaker) {
      breaker.destroy();
      this.breakers.delete(instanceName);
    }
  }

  /**
   * Get status of all circuit breakers
   */
  getAllStatus(): Map<string, ReturnType<CircuitBreaker['getStatus']>> {
    const status = new Map<string, ReturnType<CircuitBreaker['getStatus']>>();
    for (const [name, breaker] of this.breakers) {
      status.set(name, breaker.getStatus());
    }
    return status;
  }

  /**
   * Get all open circuits
   */
  getOpenCircuits(): string[] {
    const open: string[] = [];
    for (const [name, breaker] of this.breakers) {
      if (breaker.isOpen()) {
        open.push(name);
      }
    }
    return open;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}
