/**
 * PM2 Ecosystem Configuration
 *
 * Defines two processes:
 * 1. evolution-api - Main API server
 * 2. evolution-watchdog - External health monitor
 *
 * Start both: pm2 start ecosystem.config.js
 * Start only API: pm2 start ecosystem.config.js --only evolution-api
 * Start only watchdog: pm2 start ecosystem.config.js --only evolution-watchdog
 */

module.exports = {
  apps: [
    {
      // Main Evolution API Server
      name: 'evolution-api',
      script: 'dist/main.js',
      cwd: '/root/evolution-api',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      // Logging
      error_file: '/root/.pm2/logs/evolution-api-error.log',
      out_file: '/root/.pm2/logs/evolution-api-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Restart policy
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
      // Graceful shutdown
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 10000,
    },
    {
      // External Watchdog Process
      name: 'evolution-watchdog',
      script: 'dist/watchdog/index.js',
      cwd: '/root/evolution-api',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        // ✅ OTTIMIZZAZIONE: Tempi ridotti per recovery più veloce (worst case ~2.5 min invece di ~8.5 min)
        WATCHDOG_CHECK_INTERVAL: '30000', // Check every 30 seconds (era 60000)
        WATCHDOG_HEARTBEAT_TIMEOUT: '60000', // 60s without heartbeat = stuck (era 90000)
        WATCHDOG_STUCK_TIMEOUT: '90000', // 90s in connecting = stuck (era 120000)
        WATCHDOG_MAX_ATTEMPTS: '2', // 2 API attempts, then PM2 restart (era 5)
        WATCHDOG_DEBUG: 'false', // Set to 'true' for verbose logging
        PM2_PROCESS_NAME: 'evolution-api',
      },
      // Logging
      error_file: '/root/.pm2/logs/evolution-watchdog-error.log',
      out_file: '/root/.pm2/logs/evolution-watchdog-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Restart policy - watchdog should be very stable
      exp_backoff_restart_delay: 1000,
      max_restarts: 5,
      min_uptime: '30s',
      // Lower priority
      node_args: '--max-old-space-size=256',
    },
  ],
};
