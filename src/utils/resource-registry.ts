/**
 * Resource Registry - Centralized Tracking for ALL Resources
 *
 * Tracks timers, event listeners, child processes (FFmpeg), and connections
 * to prevent memory leaks and enable emergency cleanup.
 *
 * Part of the "Defense in Depth" architecture - Layer 1
 */

import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Tracked event listener interface
 */
export interface TrackedListener {
  id: string;
  target: EventEmitter | any;
  event: string;
  handler: (...args: any[]) => void;
  addedAt: number;
  description?: string;
}

/**
 * Tracked timer interface
 */
export interface TrackedTimer {
  timer: NodeJS.Timeout;
  description: string;
  addedAt: number;
  isInterval: boolean;
}

/**
 * Tracked child process interface
 */
export interface TrackedProcess {
  process: ChildProcess;
  description: string;
  addedAt: number;
  pid?: number;
}

/**
 * Resource statistics interface
 */
export interface ResourceStats {
  timers: number;
  intervals: number;
  eventListeners: number;
  childProcesses: number;
  totalResources: number;
  oldestResource?: {
    type: string;
    description: string;
    ageMs: number;
  };
}

/**
 * ResourceRegistry - Central tracking for all instance resources
 *
 * @example
 * const registry = new ResourceRegistry('instance-123');
 *
 * // Track a timer
 * const timer = setTimeout(() => { ... }, 5000);
 * registry.addTimer(timer, 'reconnect-timer');
 *
 * // Track an event listener
 * const handler = (data) => console.log(data);
 * registry.addListener('ws-message', socket, 'message', handler);
 *
 * // Clean up everything
 * registry.cleanupAll('instance shutdown');
 */
export class ResourceRegistry {
  private instanceName: string;
  private timers: Map<NodeJS.Timeout, TrackedTimer> = new Map();
  private eventListeners: Map<string, TrackedListener> = new Map();
  private childProcesses: Set<TrackedProcess> = new Set();
  private isCleaningUp: boolean = false;

  constructor(instanceName: string) {
    this.instanceName = instanceName;
  }

  /**
   * Update the instance name (used after instance name is set)
   * ✅ BUG FIX: Permette di aggiornare il nome dopo la costruzione
   */
  public updateName(newName: string): void {
    this.instanceName = newName;
  }

  /**
   * Get the current instance name
   */
  public getName(): string {
    return this.instanceName;
  }

  // ==========================================
  // TIMER MANAGEMENT
  // ==========================================

  /**
   * Add a timer (setTimeout) to tracking
   */
  addTimer(timer: NodeJS.Timeout, description: string): void {
    if (this.isCleaningUp) return;

    this.timers.set(timer, {
      timer,
      description,
      addedAt: Date.now(),
      isInterval: false,
    });
  }

  /**
   * Add an interval (setInterval) to tracking
   */
  addInterval(interval: NodeJS.Timeout, description: string): void {
    if (this.isCleaningUp) return;

    this.timers.set(interval, {
      timer: interval,
      description,
      addedAt: Date.now(),
      isInterval: true,
    });
  }

  /**
   * Remove a timer/interval from tracking and clear it
   */
  removeTimer(timer: NodeJS.Timeout): boolean {
    const tracked = this.timers.get(timer);
    if (tracked) {
      if (tracked.isInterval) {
        clearInterval(timer);
      } else {
        clearTimeout(timer);
      }
      this.timers.delete(timer);
      return true;
    }
    return false;
  }

  /**
   * Clear all tracked timers
   */
  clearAllTimers(): number {
    let cleared = 0;
    for (const [timer, tracked] of this.timers) {
      try {
        if (tracked.isInterval) {
          clearInterval(timer);
        } else {
          clearTimeout(timer);
        }
        cleared++;
      } catch {
        // Ignore errors - timer may already be cleared
      }
    }
    this.timers.clear();
    return cleared;
  }

  // ==========================================
  // EVENT LISTENER MANAGEMENT
  // ==========================================

  /**
   * Add an event listener with tracking
   *
   * @param id Unique identifier for this listener
   * @param target The EventEmitter or object with on/off methods
   * @param event The event name
   * @param handler The handler function
   * @param description Optional description
   */
  addListener(
    id: string,
    target: EventEmitter | any,
    event: string,
    handler: (...args: any[]) => void,
    description?: string,
  ): void {
    if (this.isCleaningUp) return;

    // Remove existing listener with same ID first
    this.removeListener(id);

    // Add the listener to the target
    if (typeof target.on === 'function') {
      target.on(event, handler);
    } else if (typeof target.addEventListener === 'function') {
      target.addEventListener(event, handler);
    }

    // Track it
    this.eventListeners.set(id, {
      id,
      target,
      event,
      handler,
      addedAt: Date.now(),
      description: description || `${event} listener`,
    });
  }

  /**
   * Remove a tracked event listener by ID
   */
  removeListener(id: string): boolean {
    const tracked = this.eventListeners.get(id);
    if (tracked) {
      try {
        if (typeof tracked.target.off === 'function') {
          tracked.target.off(tracked.event, tracked.handler);
        } else if (typeof tracked.target.removeListener === 'function') {
          tracked.target.removeListener(tracked.event, tracked.handler);
        } else if (typeof tracked.target.removeEventListener === 'function') {
          tracked.target.removeEventListener(tracked.event, tracked.handler);
        }
      } catch {
        // Ignore - target may be destroyed
      }
      this.eventListeners.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Remove all listeners from a specific target
   */
  removeListenersForTarget(target: EventEmitter | any): number {
    let removed = 0;
    for (const [id, tracked] of this.eventListeners) {
      if (tracked.target === target) {
        this.removeListener(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Remove all tracked event listeners
   */
  removeAllListeners(): number {
    let removed = 0;
    for (const id of this.eventListeners.keys()) {
      if (this.removeListener(id)) {
        removed++;
      }
    }
    return removed;
  }

  // ==========================================
  // CHILD PROCESS MANAGEMENT (FFmpeg, etc.)
  // ==========================================

  /**
   * Add a child process to tracking
   */
  addProcess(process: ChildProcess, description: string): void {
    if (this.isCleaningUp) return;

    this.childProcesses.add({
      process,
      description,
      addedAt: Date.now(),
      pid: process.pid,
    });

    // Auto-remove when process exits
    process.once('exit', () => {
      this.removeProcess(process);
    });

    process.once('error', () => {
      this.removeProcess(process);
    });
  }

  /**
   * Remove a child process from tracking
   */
  removeProcess(process: ChildProcess): boolean {
    for (const tracked of this.childProcesses) {
      if (tracked.process === process) {
        this.childProcesses.delete(tracked);
        return true;
      }
    }
    return false;
  }

  /**
   * Kill all tracked child processes
   */
  killAllProcesses(signal: NodeJS.Signals = 'SIGKILL'): number {
    let killed = 0;
    for (const tracked of this.childProcesses) {
      try {
        tracked.process.kill(signal);
        killed++;
      } catch {
        // Ignore - process may already be dead
      }
    }
    this.childProcesses.clear();
    return killed;
  }

  // ==========================================
  // STATISTICS AND MONITORING
  // ==========================================

  /**
   * Get statistics about tracked resources
   */
  getStats(): ResourceStats {
    const now = Date.now();
    let oldestResource: ResourceStats['oldestResource'] | undefined;
    let oldestAge = 0;

    // Check timers
    for (const tracked of this.timers.values()) {
      const age = now - tracked.addedAt;
      if (age > oldestAge) {
        oldestAge = age;
        oldestResource = {
          type: tracked.isInterval ? 'interval' : 'timer',
          description: tracked.description,
          ageMs: age,
        };
      }
    }

    // Check listeners
    for (const tracked of this.eventListeners.values()) {
      const age = now - tracked.addedAt;
      if (age > oldestAge) {
        oldestAge = age;
        oldestResource = {
          type: 'listener',
          description: tracked.description || tracked.event,
          ageMs: age,
        };
      }
    }

    // Check processes
    for (const tracked of this.childProcesses) {
      const age = now - tracked.addedAt;
      if (age > oldestAge) {
        oldestAge = age;
        oldestResource = {
          type: 'process',
          description: tracked.description,
          ageMs: age,
        };
      }
    }

    const timerCount = Array.from(this.timers.values()).filter((t) => !t.isInterval).length;
    const intervalCount = Array.from(this.timers.values()).filter((t) => t.isInterval).length;

    return {
      timers: timerCount,
      intervals: intervalCount,
      eventListeners: this.eventListeners.size,
      childProcesses: this.childProcesses.size,
      totalResources: timerCount + intervalCount + this.eventListeners.size + this.childProcesses.size,
      oldestResource,
    };
  }

  /**
   * Check if any resources are leaking (older than threshold)
   */
  hasLeaks(thresholdMs: number = 300000): boolean {
    // 5 minutes default
    const stats = this.getStats();
    return stats.oldestResource !== undefined && stats.oldestResource.ageMs > thresholdMs;
  }

  // ==========================================
  // CLEANUP
  // ==========================================

  /**
   * SCORCHED EARTH: Clean up ALL resources
   *
   * Use this for emergency cleanup when something is stuck
   *
   * @param reason Reason for cleanup (for logging)
   * @returns Object with counts of cleaned resources
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  cleanupAll(_reason: string = 'cleanup'): {
    timers: number;
    listeners: number;
    processes: number;
    total: number;
  } {
    this.isCleaningUp = true;

    const timersCleared = this.clearAllTimers();
    const listenersRemoved = this.removeAllListeners();
    const processesKilled = this.killAllProcesses();

    this.isCleaningUp = false;

    const total = timersCleared + listenersRemoved + processesKilled;

    return {
      timers: timersCleared,
      listeners: listenersRemoved,
      processes: processesKilled,
      total,
    };
  }

  /**
   * Get detailed report of all tracked resources
   */
  getDetailedReport(): {
    instanceName: string;
    timers: Array<{ description: string; ageMs: number; isInterval: boolean }>;
    listeners: Array<{ id: string; event: string; ageMs: number }>;
    processes: Array<{ description: string; pid?: number; ageMs: number }>;
  } {
    const now = Date.now();

    return {
      instanceName: this.instanceName,
      timers: Array.from(this.timers.values()).map((t) => ({
        description: t.description,
        ageMs: now - t.addedAt,
        isInterval: t.isInterval,
      })),
      listeners: Array.from(this.eventListeners.values()).map((l) => ({
        id: l.id,
        event: l.event,
        ageMs: now - l.addedAt,
      })),
      processes: Array.from(this.childProcesses).map((p) => ({
        description: p.description,
        pid: p.pid,
        ageMs: now - p.addedAt,
      })),
    };
  }
}

/**
 * Global registry for cross-instance resource tracking
 * Useful for the watchdog to monitor all instances
 */
export class GlobalResourceRegistry {
  private static instance: GlobalResourceRegistry;
  private registries: Map<string, ResourceRegistry> = new Map();

  private constructor() {}

  static getInstance(): GlobalResourceRegistry {
    if (!GlobalResourceRegistry.instance) {
      GlobalResourceRegistry.instance = new GlobalResourceRegistry();
    }
    return GlobalResourceRegistry.instance;
  }

  /**
   * Get or create a registry for an instance
   */
  getRegistry(instanceName: string): ResourceRegistry {
    let registry = this.registries.get(instanceName);
    if (!registry) {
      registry = new ResourceRegistry(instanceName);
      this.registries.set(instanceName, registry);
    }
    return registry;
  }

  /**
   * Remove a registry (when instance is deleted)
   */
  removeRegistry(instanceName: string): void {
    const registry = this.registries.get(instanceName);
    if (registry) {
      registry.cleanupAll('registry removed');
      this.registries.delete(instanceName);
    }
  }

  /**
   * Get stats for all instances
   */
  getAllStats(): Map<string, ResourceStats> {
    const stats = new Map<string, ResourceStats>();
    for (const [name, registry] of this.registries) {
      stats.set(name, registry.getStats());
    }
    return stats;
  }

  /**
   * Clean up all registries
   */
  cleanupAll(reason: string = 'global cleanup'): void {
    for (const registry of this.registries.values()) {
      registry.cleanupAll(reason);
    }
  }
}
