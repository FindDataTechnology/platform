#!/bin/bash
# Monitor Agent Cluster Platform - Monitoring Script
# Usage: ./scripts/monitor-cluster-platform.sh

set -e

echo "📊 Agent Cluster Platform Monitor"
echo "=================================="
echo ""

DATA_DIR="${DATA_DIR:-./data}"
DB_FILE="$DATA_DIR/clusters.db"
PORT="${PORT:-3000}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Check database
echo "🗄️  Database Status:"
if [ -f "$DB_FILE" ]; then
    SIZE=$(du -h "$DB_FILE" | cut -f1)
    echo -e "  ${GREEN}✅${NC} Database exists: $DB_FILE"
    echo -e "  ${GREEN}✅${NC} Size: $SIZE"
    
    # Get cluster count
    if command -v sqlite3 &> /dev/null; then
        TOTAL=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM dynamic_clusters;" 2>/dev/null || echo "0")
        ACTIVE=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM dynamic_clusters WHERE status != 'terminated';" 2>/dev/null || echo "0")
        TERMINATED=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM dynamic_clusters WHERE status = 'terminated';" 2>/dev/null || echo "0")
        
        echo -e "  ${GREEN}✅${NC} Total clusters: $TOTAL"
        echo -e "  ${GREEN}✅${NC} Active clusters: $ACTIVE"
        echo -e "  ${YELLOW}⚠️${NC} Terminated clusters: $TERMINATED"
    fi
else
    echo -e "  ${YELLOW}⚠️${NC} Database not yet created (will be created on first use)"
fi

echo ""

# Check API health
echo "🌐 API Health:"
HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/api/clusters/dynamic -X POST \
    -H "Content-Type: application/json" \
    -d '{"name":"Health","description":"","agents":[],"activateAll":true}' 2>/dev/null || echo "000")

if [ "$HEALTH_CHECK" = "400" ]; then
    echo -e "  ${GREEN}✅${NC} API responding correctly (expected 400 for invalid request)"
elif [ "$HEALTH_CHECK" = "000" ]; then
    echo -e "  ${RED}❌${NC} API not responding"
else
    echo -e "  ${YELLOW}⚠️${NC} API returned unexpected status: $HEALTH_CHECK"
fi

echo ""

# Check recent activity
echo "📈 Recent Activity (last 24 hours):"
if [ -f "$DB_FILE" ] && command -v sqlite3 &> /dev/null; then
    RECENT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM dynamic_clusters WHERE last_used_at > datetime('now', '-1 day');" 2>/dev/null || echo "0")
    echo -e "  Clusters used in last 24h: ${GREEN}$RECENT${NC}"
    
    LOW_EXEC=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM dynamic_clusters WHERE total_executions < 5 AND last_used_at < datetime('now', '-1 day');" 2>/dev/null || echo "0")
    echo -e "  Candidates for auto-termination: ${YELLOW}$LOW_EXEC${NC}"
fi

echo ""

# Rate limiting check
echo "🛡️  System Resources:"
echo -e "  Database file: $DB_FILE"
if [ -f "$DB_FILE" ]; then
    DB_SIZE=$(du -b "$DB_FILE" 2>/dev/null | cut -f1)
    echo -e "  Database size: ${DB_SIZE:-0} bytes"
fi

echo ""
echo "========================================"
echo "Monitoring complete!"
echo "========================================"
echo ""
echo "Tips:"
echo "- Use 'tail -f logs/server.log' to monitor server logs"
echo "- Watch for '[cluster]' log messages"
echo "- Check database periodically: sqlite3 $DB_FILE 'SELECT * FROM dynamic_clusters ORDER BY last_used_at DESC LIMIT 10;'"
