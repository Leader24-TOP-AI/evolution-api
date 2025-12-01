/**
 * Health Check Script - Database Verification
 *
 * Queries the database directly to verify Defense in Depth system health.
 * Used by verify-defense-in-depth.sh for comprehensive checks.
 *
 * Usage: npx tsx scripts/health-check.ts
 * Output: JSON with health metrics
 */

import { PrismaClient } from '@prisma/client';

interface HealthCheckResult {
  timestamp: string;
  heartbeatCount: number;
  recentHeartbeats: number;
  stuckCircuits: number;
  recentEvents: number;
  staleInstances: string[];
  openCircuits: string[];
  recoveryAttempts: { instanceId: string; attempts: number }[];
  error?: string;
}

async function checkHealth(): Promise<HealthCheckResult> {
  const prisma = new PrismaClient();
  const result: HealthCheckResult = {
    timestamp: new Date().toISOString(),
    heartbeatCount: 0,
    recentHeartbeats: 0,
    stuckCircuits: 0,
    recentEvents: 0,
    staleInstances: [],
    openCircuits: [],
    recoveryAttempts: [],
  };

  try {
    await prisma.$connect();

    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    // 1. Count total heartbeat records
    result.heartbeatCount = await prisma.watchdogHeartbeat.count();

    // 2. Count recent heartbeats (within 2 minutes)
    result.recentHeartbeats = await prisma.watchdogHeartbeat.count({
      where: {
        lastHeartbeat: {
          gte: twoMinutesAgo,
        },
      },
    });

    // 3. Find stale heartbeats (older than 2 minutes)
    const staleHeartbeats = await prisma.watchdogHeartbeat.findMany({
      where: {
        lastHeartbeat: {
          lt: twoMinutesAgo,
        },
      },
      select: {
        instanceId: true,
        lastHeartbeat: true,
      },
    });
    result.staleInstances = staleHeartbeats.map((h) => h.instanceId);

    // 4. Find circuit breakers stuck OPEN for more than 10 minutes
    const stuckCircuits = await prisma.watchdogHeartbeat.findMany({
      where: {
        circuitState: 'OPEN',
        updatedAt: {
          lt: tenMinutesAgo,
        },
      },
      select: {
        instanceId: true,
      },
    });
    result.stuckCircuits = stuckCircuits.length;
    result.openCircuits = stuckCircuits.map((c) => c.instanceId);

    // 5. Count recent health events (last hour)
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    result.recentEvents = await prisma.healthEvent.count({
      where: {
        createdAt: {
          gte: oneHourAgo,
        },
      },
    });

    // 6. Get instances with high recovery attempts
    const highRecoveryInstances = await prisma.watchdogHeartbeat.findMany({
      where: {
        recoveryAttempts: {
          gt: 3,
        },
      },
      select: {
        instanceId: true,
        recoveryAttempts: true,
      },
    });
    result.recoveryAttempts = highRecoveryInstances.map((h) => ({
      instanceId: h.instanceId,
      attempts: h.recoveryAttempts,
    }));

    await prisma.$disconnect();
  } catch (error: unknown) {
    result.error = error instanceof Error ? error.message : String(error);
    try {
      await prisma.$disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }

  return result;
}

// Main execution
checkHealth()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.error ? 1 : 0);
  })
  .catch((error) => {
    console.log(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  });
