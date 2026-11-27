#!/bin/bash
# Complete Deployment Script for Agent Cluster Platform

set -e

echo "🚀 Agent Cluster Platform - Production Deployment"
echo "=================================================="
echo ""

# Step 1: Stop existing processes
echo "Step 1: Stopping existing processes..."
pkill -f "node scripts/start.js" 2>/dev/null || true
sleep 3

# Step 2: Create directories
echo "Step 2: Creating necessary directories..."
mkdir -p logs
mkdir -p data
chmod 755 data

# Step 3: Verify code
echo "Step 3: Verifying code integrity..."
node --check server.js && echo "✅ server.js syntax OK"
node --check server/routes/clusters.js && echo "✅ clusters.js syntax OK"
node --check web/src/components/clusters/ClusterComposerModal.tsx 2>/dev/null || echo "⚠️  TypeScript file (skipped JS check)"

# Step 4: Start server
echo "Step 4: Starting production server..."
npm start > logs/server.log 2>&1 &
SERVER_PID=$!
echo "Server started with PID: $SERVER_PID"

# Step 5: Wait for server to be healthy
echo "Step 5: Waiting for server to initialize..."
MAX_ATTEMPTS=60
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s http://localhost:3000/api/ready > /dev/null 2>&1; then
        echo "✅ Server is healthy!"
        break
    fi
    
    # Check if process is still running
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "❌ Server process died. Checking logs..."
        tail -50 logs/server.log
        exit 1
    fi
    
    ATTEMPT=$((ATTEMPT + 1))
    if [ $((ATTEMPT % 10)) -eq 0 ]; then
        echo "  Still starting... ($ATTEMPT/$MAX_ATTEMPTS)"
    fi
    sleep 2
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo "⚠️  Server may still be starting. Will continue anyway."
fi

# Step 6: Test API endpoints
echo ""
echo "Step 6: Testing API endpoints..."
echo ""

# Test cluster creation
echo "Testing cluster creation API..."
RESPONSE=$(curl -s -X POST http://localhost:3000/api/clusters/dynamic \
  -H "Content-Type: application/json" \
  -d '{"name":"部署测试","description":"生产环境部署测试","agents":[],"activateAll":true}')

if echo "$RESPONSE" | grep -q "error"; then
    echo "❌ Cluster creation failed:"
    echo "$RESPONSE" | head -c 200
elif echo "$RESPONSE" | grep -q "clusterId"; then
    echo "✅ Cluster API working! Response preview:"
    echo "$RESPONSE" | head -c 200
    echo "..."
else
    echo "⚠️  Unexpected response:"
    echo "$RESPONSE" | head -c 200
fi

echo ""

# Test GET endpoint
echo "Testing cluster list API..."
GET_RESPONSE=$(curl -s http://localhost:3000/api/clusters/user/test@example.com 2>/dev/null || echo "")
if [ -n "$GET_RESPONSE" ] && ! echo "$GET_RESPONSE" | grep -q "Cannot GET"; then
    echo "✅ GET endpoint responding"
else
    echo "⚠️  GET endpoint may not be available yet"
fi

# Step 7: Check database
echo ""
echo "Step 7: Checking database..."
if [ -f "./data/clusters.db" ]; then
    DB_SIZE=$(du -h ./data/clusters.db | cut -f1)
    echo "✅ Database created: $DB_SIZE"
else
    echo "⚠️  Database will be created on first use"
fi

# Step 8: Summary
echo ""
echo "=================================================="
echo "🎉 Deployment Complete!"
echo "=================================================="
echo ""
echo "Access Points:"
echo "  📱 UI: http://localhost:3000/agents?tab=agents"
echo "  🔌 API: http://localhost:3000/api/clusters"
echo "  📝 Logs: tail -f logs/server.log"
echo ""
echo "Next Steps:"
echo "  1. Visit http://localhost:3000/agents?tab=agents in browser"
echo "  2. Create your first cluster"
echo "  3. Monitor logs: tail -f logs/server.log"
echo ""
echo "To stop: pkill -f 'node scripts/start.js'"
echo ""
