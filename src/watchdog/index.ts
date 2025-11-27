#!/usr/bin/env node
/**
 * Watchdog Entry Point
 *
 * Runs as a SEPARATE PM2 process from the main Evolution API.
 * Monitors WhatsApp instance health and triggers recovery when needed.
 *
 * Start with: pm2 start ecosystem.config.js
 */

import { WatchdogService } from './watchdog.service';

// Parse command line arguments
const args = process.argv.slice(2);
const debug = args.includes('--debug') || process.env.WATCHDOG_DEBUG === 'true';

if (debug) {
  process.env.WATCHDOG_DEBUG = 'true';
}

console.log(`
╔═══════════════════════════════════════════════════════════╗
║          EVOLUTION API - EXTERNAL WATCHDOG                ║
║                                                           ║
║  Defense in Depth - Layer 3 (Last Line of Defense)        ║
║                                                           ║
║  Monitors WhatsApp instances for stuck states and         ║
║  triggers automatic recovery actions.                     ║
╚═══════════════════════════════════════════════════════════╝
`);

// Configuration from environment
const config = {
  checkInterval: parseInt(process.env.WATCHDOG_CHECK_INTERVAL || '60000', 10),
  heartbeatTimeout: parseInt(process.env.WATCHDOG_HEARTBEAT_TIMEOUT || '90000', 10),
  stuckConnectingTimeout: parseInt(process.env.WATCHDOG_STUCK_TIMEOUT || '120000', 10),
  maxRecoveryAttempts: parseInt(process.env.WATCHDOG_MAX_ATTEMPTS || '5', 10),
  apiBaseUrl: process.env.SERVER_URL || 'http://localhost:8080',
  apiKey: process.env.AUTHENTICATION_API_KEY || '',
  pm2ProcessName: process.env.PM2_PROCESS_NAME || 'evolution-api',
};

console.log('Configuration:');
console.log(`  - Check Interval: ${config.checkInterval}ms`);
console.log(`  - Heartbeat Timeout: ${config.heartbeatTimeout}ms`);
console.log(`  - Stuck Connecting Timeout: ${config.stuckConnectingTimeout}ms`);
console.log(`  - Max Recovery Attempts: ${config.maxRecoveryAttempts}`);
console.log(`  - API URL: ${config.apiBaseUrl}`);
console.log(`  - PM2 Process: ${config.pm2ProcessName}`);
console.log(`  - Debug Mode: ${debug}`);
console.log('');

// Create and start watchdog
const watchdog = new WatchdogService(config);

watchdog.start().catch((error) => {
  console.error('Failed to start watchdog:', error);
  process.exit(1);
});

// Handle critical errors - exit so PM2 can restart with clean state
process.on('uncaughtException', (error) => {
  console.error('CRITICAL: Uncaught exception in watchdog:', error);
  // Exit after brief delay to allow logging
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  console.error('CRITICAL: Unhandled rejection in watchdog:', reason);
  // Exit after brief delay to allow logging
  setTimeout(() => process.exit(1), 500);
});
