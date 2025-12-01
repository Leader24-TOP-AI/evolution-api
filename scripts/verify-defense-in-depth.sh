#!/bin/bash
#
# Defense in Depth - Production Verification Script
# Verifies that the anti-blocking system is working correctly
#
# Usage: ./scripts/verify-defense-in-depth.sh
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Load environment variables safely (don't source entire .env)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Extract specific variables from .env file
if [ -f "$PROJECT_DIR/.env" ]; then
    API_KEY=$(grep -E "^AUTHENTICATION_API_KEY=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    BASE_URL=$(grep -E "^SERVER_URL=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "http://localhost:8080")
    DATABASE_CONNECTION_URI=$(grep -E "^DATABASE_CONNECTION_URI=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
fi

# Fallback to environment variables if not in .env
API_KEY="${API_KEY:-$AUTHENTICATION_API_KEY}"
BASE_URL="${BASE_URL:-http://localhost:8080}"

# Counters
PASSED=0
FAILED=0
WARNINGS=0

# Print header
echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     DEFENSE IN DEPTH - PRODUCTION VERIFICATION          ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Base URL: $BASE_URL"
echo "Timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Helper function to check status
check() {
    local name="$1"
    local status="$2"
    local message="$3"

    if [ "$status" = "pass" ]; then
        echo -e "${GREEN}✓${NC} $name: $message"
        PASSED=$((PASSED + 1))
    elif [ "$status" = "warn" ]; then
        echo -e "${YELLOW}⚠${NC} $name: $message"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "${RED}✗${NC} $name: $message"
        FAILED=$((FAILED + 1))
    fi
}

# ==========================================
# CHECK 1-3: PM2 Process Status
# ==========================================
echo -e "\n${BLUE}[1/4] PM2 Process Status${NC}"
echo "----------------------------------------"

# Check evolution-api
API_STATUS=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="evolution-api") | .pm2_env.status' 2>/dev/null || echo "not_found")
API_UPTIME=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="evolution-api") | .pm2_env.pm_uptime' 2>/dev/null || echo "0")

if [ "$API_STATUS" = "online" ]; then
    UPTIME_SEC=$(( ($(date +%s%3N) - ${API_UPTIME:-0}) / 1000 ))
    if [ $UPTIME_SEC -gt 60 ]; then
        check "PM2 evolution-api" "pass" "running (uptime: ${UPTIME_SEC}s)"
    else
        check "PM2 evolution-api" "warn" "running but recently restarted (uptime: ${UPTIME_SEC}s)"
    fi
else
    check "PM2 evolution-api" "fail" "NOT RUNNING (status: $API_STATUS)"
fi

# Check evolution-watchdog
WATCHDOG_STATUS=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="evolution-watchdog") | .pm2_env.status' 2>/dev/null || echo "not_found")
WATCHDOG_UPTIME=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="evolution-watchdog") | .pm2_env.pm_uptime' 2>/dev/null || echo "0")

if [ "$WATCHDOG_STATUS" = "online" ]; then
    UPTIME_SEC=$(( ($(date +%s%3N) - ${WATCHDOG_UPTIME:-0}) / 1000 ))
    if [ $UPTIME_SEC -gt 60 ]; then
        check "PM2 evolution-watchdog" "pass" "running (uptime: ${UPTIME_SEC}s)"
    else
        check "PM2 evolution-watchdog" "warn" "running but recently restarted (uptime: ${UPTIME_SEC}s)"
    fi
else
    check "PM2 evolution-watchdog" "fail" "NOT RUNNING (status: $WATCHDOG_STATUS)"
fi

# Check restart count
API_RESTARTS=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="evolution-api") | .pm2_env.restart_time' 2>/dev/null || echo "0")
WATCHDOG_RESTARTS=$(pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="evolution-watchdog") | .pm2_env.restart_time' 2>/dev/null || echo "0")

if [ "${API_RESTARTS:-0}" -gt 10 ] || [ "${WATCHDOG_RESTARTS:-0}" -gt 10 ]; then
    check "PM2 restart count" "warn" "API: $API_RESTARTS, Watchdog: $WATCHDOG_RESTARTS (high restart count)"
else
    check "PM2 restart count" "pass" "API: $API_RESTARTS, Watchdog: $WATCHDOG_RESTARTS"
fi

# ==========================================
# CHECK 4-6: Health Monitor API
# ==========================================
echo -e "\n${BLUE}[2/4] Health Monitor API${NC}"
echo "----------------------------------------"

if [ -z "$API_KEY" ]; then
    check "API Key" "fail" "AUTHENTICATION_API_KEY not set"
else
    # Check system health endpoint
    HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" -H "apikey: $API_KEY" "$BASE_URL/health-monitor/system" 2>/dev/null)
    HTTP_CODE=$(echo "$HEALTH_RESPONSE" | tail -n1)
    HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
        check "API /health-monitor/system" "pass" "HTTP $HTTP_CODE"

        # Parse response
        WATCHDOG_STATUS=$(echo "$HEALTH_BODY" | jq -r '.watchdogStatus' 2>/dev/null || echo "unknown")
        AVG_HEALTH=$(echo "$HEALTH_BODY" | jq -r '.averageHealthScore' 2>/dev/null || echo "0")
        TOTAL_INSTANCES=$(echo "$HEALTH_BODY" | jq -r '.totalInstances' 2>/dev/null || echo "0")
        STUCK_INSTANCES=$(echo "$HEALTH_BODY" | jq -r '.stuckInstances' 2>/dev/null || echo "0")
        CIRCUIT_OPEN=$(echo "$HEALTH_BODY" | jq -r '.circuitBreakerOpen' 2>/dev/null || echo "0")

        # Check watchdog status
        if [ "$WATCHDOG_STATUS" = "running" ]; then
            check "Watchdog status" "pass" "$WATCHDOG_STATUS"
        elif [ "$WATCHDOG_STATUS" = "stopped" ]; then
            check "Watchdog status" "fail" "$WATCHDOG_STATUS - watchdog not detecting heartbeats"
        else
            check "Watchdog status" "warn" "$WATCHDOG_STATUS"
        fi

        # Check health score
        if [ "${AVG_HEALTH:-0}" -ge 80 ]; then
            check "Average health score" "pass" "$AVG_HEALTH/100"
        elif [ "${AVG_HEALTH:-0}" -ge 50 ]; then
            check "Average health score" "warn" "$AVG_HEALTH/100 (degraded)"
        else
            check "Average health score" "fail" "$AVG_HEALTH/100 (critical)"
        fi

        # Check stuck instances
        if [ "${STUCK_INSTANCES:-0}" -eq 0 ]; then
            check "Stuck instances" "pass" "none"
        else
            check "Stuck instances" "fail" "$STUCK_INSTANCES stuck instances detected"
        fi

        # Check circuit breakers
        if [ "${CIRCUIT_OPEN:-0}" -eq 0 ]; then
            check "Circuit breakers" "pass" "all closed"
        else
            check "Circuit breakers" "warn" "$CIRCUIT_OPEN circuit breakers OPEN"
        fi

        echo "  └─ Total instances: $TOTAL_INSTANCES"
    else
        check "API /health-monitor/system" "fail" "HTTP $HTTP_CODE"
    fi
fi

# ==========================================
# CHECK 7-9: Database Verification
# ==========================================
echo -e "\n${BLUE}[3/4] Database Verification${NC}"
echo "----------------------------------------"

# Run TypeScript health check if available
if [ -f "$PROJECT_DIR/scripts/health-check.ts" ]; then
    DB_CHECK=$(cd "$PROJECT_DIR" && npx tsx scripts/health-check.ts 2>/dev/null || echo '{"error": true}')

    if echo "$DB_CHECK" | jq -e '.error' > /dev/null 2>&1; then
        check "Database connection" "fail" "could not connect to database"
    else
        HEARTBEAT_COUNT=$(echo "$DB_CHECK" | jq -r '.heartbeatCount' 2>/dev/null || echo "0")
        RECENT_HEARTBEATS=$(echo "$DB_CHECK" | jq -r '.recentHeartbeats' 2>/dev/null || echo "0")
        STUCK_CIRCUITS=$(echo "$DB_CHECK" | jq -r '.stuckCircuits' 2>/dev/null || echo "0")
        RECENT_EVENTS=$(echo "$DB_CHECK" | jq -r '.recentEvents' 2>/dev/null || echo "0")

        # Check heartbeat records
        if [ "${HEARTBEAT_COUNT:-0}" -gt 0 ]; then
            check "DB heartbeat records" "pass" "$HEARTBEAT_COUNT total"
        else
            check "DB heartbeat records" "warn" "no heartbeat records found"
        fi

        # Check recent heartbeats (within 2 minutes)
        if [ "${RECENT_HEARTBEATS:-0}" -gt 0 ]; then
            check "DB recent heartbeats" "pass" "$RECENT_HEARTBEATS within last 2 minutes"
        else
            check "DB recent heartbeats" "fail" "no recent heartbeats (watchdog may be stuck)"
        fi

        # Check stuck circuits
        if [ "${STUCK_CIRCUITS:-0}" -eq 0 ]; then
            check "DB stuck circuits" "pass" "none"
        else
            check "DB stuck circuits" "fail" "$STUCK_CIRCUITS circuits stuck OPEN > 10 minutes"
        fi

        echo "  └─ Recent health events: $RECENT_EVENTS"
    fi
else
    # Fallback: Direct database query via psql
    if command -v psql &> /dev/null && [ -n "$DATABASE_CONNECTION_URI" ]; then
        # Extract connection details
        DB_HOST=$(echo "$DATABASE_CONNECTION_URI" | sed -n 's/.*@\([^:\/]*\).*/\1/p')
        DB_PORT=$(echo "$DATABASE_CONNECTION_URI" | sed -n 's/.*:\([0-9]*\)\/.*/\1/p')
        DB_NAME=$(echo "$DATABASE_CONNECTION_URI" | sed -n 's/.*\/\([^?]*\).*/\1/p')
        DB_USER=$(echo "$DATABASE_CONNECTION_URI" | sed -n 's/.*:\/\/\([^:]*\):.*/\1/p')
        DB_PASS=$(echo "$DATABASE_CONNECTION_URI" | sed -n 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/p')

        HEARTBEAT_COUNT=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM \"WatchdogHeartbeat\"" 2>/dev/null | tr -d ' ' || echo "0")

        if [ "${HEARTBEAT_COUNT:-0}" -gt 0 ]; then
            check "DB heartbeat records" "pass" "$HEARTBEAT_COUNT total"
        else
            check "DB heartbeat records" "warn" "no records or could not query"
        fi

        check "DB health-check.ts" "warn" "script not found, using fallback query"
    else
        check "Database verification" "warn" "skipped (health-check.ts not found, psql not available)"
    fi
fi

# ==========================================
# CHECK 10-12: Log Analysis
# ==========================================
echo -e "\n${BLUE}[4/4] Log Analysis${NC}"
echo "----------------------------------------"

# Check watchdog logs
WATCHDOG_LOG="/root/.pm2/logs/evolution-watchdog-out.log"
if [ -f "$WATCHDOG_LOG" ]; then
    # Check for recent activity (last 2 minutes)
    RECENT_LOG=$(tail -100 "$WATCHDOG_LOG" 2>/dev/null | grep -E "^\[" | tail -1)
    if [ -n "$RECENT_LOG" ]; then
        LOG_TIME=$(echo "$RECENT_LOG" | grep -oE '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}' | head -1)
        if [ -n "$LOG_TIME" ]; then
            LOG_EPOCH=$(date -d "$LOG_TIME" +%s 2>/dev/null || echo "0")
            NOW_EPOCH=$(date +%s)
            AGE=$((NOW_EPOCH - LOG_EPOCH))

            if [ $AGE -lt 120 ]; then
                check "Watchdog log activity" "pass" "last entry ${AGE}s ago"
            else
                check "Watchdog log activity" "warn" "last entry ${AGE}s ago (may be idle)"
            fi
        else
            check "Watchdog log activity" "warn" "could not parse timestamp"
        fi
    else
        check "Watchdog log activity" "warn" "no recent log entries"
    fi

    # Check for errors
    ERROR_COUNT=$(tail -500 "$WATCHDOG_LOG" 2>/dev/null | grep -c "\[ERROR\]" 2>/dev/null) || ERROR_COUNT=0
    if [ "${ERROR_COUNT:-0}" -eq 0 ]; then
        check "Watchdog errors" "pass" "no errors in last 500 lines"
    elif [ "${ERROR_COUNT:-0}" -lt 5 ]; then
        check "Watchdog errors" "warn" "$ERROR_COUNT errors in last 500 lines"
    else
        check "Watchdog errors" "fail" "$ERROR_COUNT errors in last 500 lines (review logs)"
    fi

    # Check for recovery events
    RECOVERY_COUNT=$(tail -500 "$WATCHDOG_LOG" 2>/dev/null | grep -c "recovery" 2>/dev/null) || RECOVERY_COUNT=0
    if [ "${RECOVERY_COUNT:-0}" -eq 0 ]; then
        check "Recovery events" "pass" "no recent recoveries needed"
    else
        check "Recovery events" "warn" "$RECOVERY_COUNT recovery events in recent logs"
    fi
else
    check "Watchdog logs" "warn" "log file not found at $WATCHDOG_LOG"
fi

# ==========================================
# SUMMARY
# ==========================================
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                       SUMMARY                            ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${GREEN}Passed:${NC}   $PASSED"
echo -e "  ${YELLOW}Warnings:${NC} $WARNINGS"
echo -e "  ${RED}Failed:${NC}   $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║           RESULT: SYSTEM OK ✓                            ║${NC}"
        echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
        exit 0
    else
        echo -e "${YELLOW}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${YELLOW}║       RESULT: SYSTEM OK WITH WARNINGS ⚠                  ║${NC}"
        echo -e "${YELLOW}╚══════════════════════════════════════════════════════════╝${NC}"
        exit 0
    fi
else
    echo -e "${RED}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║           RESULT: ISSUES DETECTED ✗                      ║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════════════╝${NC}"
    exit 1
fi
