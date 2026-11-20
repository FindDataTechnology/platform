#!/bin/bash
# Start Agent Cluster Platform in Production Mode

echo "🚀 Starting Agent Cluster Platform..."
echo ""

# Create necessary directories
mkdir -p logs
mkdir -p data

# Kill any existing processes
pkill -f "node scripts/start.js" 2>/dev/null
sleep 2

# Start the server
echo "Starting server..."
npm start > logs/server.log 2>&1 &
SERVER_PID=$!

echo "Server starting with PID: $SERVER_PID"
echo ""

# Wait for server to be ready
echo "Waiting for server to initialize..."
for i in {1..30}; do
    if curl -s http://localhost:3000/api/ready > /dev/null 2>&1; then
        echo "✅ Server is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "⚠️  Server may still be starting..."
        break
    fi
    sleep 2
done

echo ""
echo "=== Server Status ==="
curl -s http://localhost:3000/api/ready 2>/dev/null || echo "Health check endpoint not available yet"

echo ""
echo "=== Testing Cluster API ==="
RESPONSE=$(curl -s -X POST http://localhost:3000/api/clusters/dynamic \
  -H "Content-Type: application/json" \
  -d '{"name":"测试集群","description":"生产环境测试","agents":[],"activateAll":true}')

if echo "$RESPONSE" | grep -q "error"; then
    echo "❌ API returned error:"
    echo "$RESPONSE"
elif echo "$RESPONSE" | grep -q "clusterId"; then
    echo "✅ Cluster API working!"
    echo "$RESPONSE" | head -c 200
else
    echo "⚠️  Unexpected response:"
    echo "$RESPONSE"
fi

echo ""
echo "=== Access Points ==="
echo "📱 UI: http://localhost:3000/agents?tab=agents"
echo "🔌 API: http://localhost:3000/api/clusters"
echo "📝 Logs: tail -f logs/server.log"

echo ""
echo "To stop the server: pkill -f 'node scripts/start.js'"
echo ""
echo "🎉 Agent Cluster Platform is now running!"
