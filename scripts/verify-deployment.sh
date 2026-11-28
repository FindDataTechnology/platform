#!/bin/bash
# Agent Cluster Platform - Deployment Verification Script
# Usage: ./scripts/verify-deployment.sh

set -e

echo "🔍 Verifying Agent Cluster Platform Deployment"
echo "================================================"
echo ""

ERRORS=0

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Step 1: Check required files exist
echo "📁 Checking required files..."
REQUIRED_FILES=(
    "server/routes/clusters.js"
    "server/routes/clusters-db.js"
    "web/src/components/clusters/ClusterComposerModal.tsx"
    "lib/pack-manifest.js"
    "catalog.js"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "  ${GREEN}✅${NC} $file"
    else
        echo -e "  ${RED}❌${NC} $file (MISSING)"
        ERRORS=$((ERRORS + 1))
    fi
done

echo ""

# Step 2: Run unit tests
echo "🧪 Running unit tests..."
cd scripts || exit
if node test-cluster-platform.mjs > /tmp/test-output.txt 2>&1; then
    echo -e "  ${GREEN}✅${NC} All tests passed"
    grep "All tests passed" /tmp/test-output.txt | tail -1
else
    echo -e "  ${RED}❌${NC} Tests failed"
    cat /tmp/test-output.txt
    ERRORS=$((ERRORS + 1))
fi
cd .. || exit

echo ""

# Step 3: Check database setup
echo "🗄️  Checking database setup..."
DATA_DIR="${DATA_DIR:-./data}"
if [ -d "$DATA_DIR" ]; then
    echo -e "  ${GREEN}✅${NC} Data directory exists: $DATA_DIR"
    
    # Check permissions
    if [ -w "$DATA_DIR" ]; then
        echo -e "  ${GREEN}✅${NC} Data directory is writable"
    else
        echo -e "  ${YELLOW}⚠️${NC} Data directory may not be writable"
    fi
else
    echo -e "  ${YELLOW}⚠️${NC} Data directory not found (will be created on first use)"
fi

echo ""

# Step 4: Check API endpoints
echo "🌐 Checking API endpoints..."
PORT="${PORT:-3000}"

# Test cluster creation endpoint
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    http://localhost:$PORT/api/clusters/dynamic \
    -X POST \
    -H "Content-Type: application/json" \
    -d '{"name":"Verify","description":"","agents":[],"activateAll":true}' 2>/dev/null || echo "000")

if [ "$RESPONSE" = "400" ]; then
    echo -e "  ${GREEN}✅${NC} POST /api/clusters/dynamic responding correctly"
elif [ "$RESPONSE" = "000" ]; then
    echo -e "  ${RED}❌${NC} API endpoint not responding (server may not be running)"
    ERRORS=$((ERRORS + 1))
else
    echo -e "  ${YELLOW}⚠️${NC} Unexpected response: $RESPONSE"
fi

# Test GET endpoint
GET_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    http://localhost:$PORT/api/clusters/nonexistent 2>/dev/null || echo "000")

if [ "$GET_RESPONSE" = "404" ]; then
    echo -e "  ${GREEN}✅${NC} GET /api/clusters/:id returning 404 correctly"
elif [ "$GET_RESPONSE" = "000" ]; then
    echo -e "  ${RED}❌${NC} GET endpoint not responding"
    ERRORS=$((ERRORS + 1))
fi

echo ""

# Step 5: Check documentation
echo "📚 Checking documentation..."
DOC_FILES=(
    "docs/agent-cluster-implementation.md"
    "docs/CLUSTER_PLATFORM_QUICKSTART.md"
    "QUICK_REFERENCE.md"
    "AGENT_CLUSTER_README.md"
)

for doc in "${DOC_FILES[@]}"; do
    if [ -f "$doc" ]; then
        echo -e "  ${GREEN}✅${NC} $doc"
    else
        echo -e "  ${YELLOW}⚠️${NC} $doc (missing)"
    fi
done

echo ""

# Step 6: Summary
echo "================================================"
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✅ Deployment verification PASSED!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Navigate to /agents?tab=agents in browser"
    echo "2. Create a test cluster"
    echo "3. Schedule a cluster task"
    echo "4. Monitor logs for '[cluster]' messages"
    echo ""
    echo "For issues, see QUICK_REFERENCE.md"
    exit 0
else
    echo -e "${RED}❌ Deployment verification FAILED!${NC}"
    echo ""
    echo "Errors found: $ERRORS"
    echo "Please fix the issues above before deploying."
    exit 1
fi
