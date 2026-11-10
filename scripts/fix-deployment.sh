#!/bin/bash
# Fix and re-deploy Agent Cluster Platform

set -e

echo "🔧 Fixing deployment issues..."

# Step 1: Verify all files exist
echo "Step 1: Checking files..."
for file in server/routes/model-binding.js server/routes/cluster-templates.js server/routes/monitoring.js server/routes/admin.js server/routes/optimization.js; do
    if [ ! -f "$file" ]; then
        echo "❌ Missing file: $file"
        exit 1
    fi
done
echo "✅ All files present"

# Step 2: Check syntax
echo "Step 2: Checking syntax..."
node --check server.js || { echo "❌ server.js has errors"; exit 1; }
echo "✅ Syntax OK"

# Step 3: Commit any uncommitted changes
echo "Step 3: Committing changes..."
git add .
git diff --cached --stat || echo "No changes to commit"

# Step 4: Push to trigger CI/CD
echo "Step 4: Pushing to trigger CI/CD..."
git push origin main || { echo "❌ Push failed"; exit 1; }

# Step 5: Show status
echo ""
echo "✅ Deployment triggered!"
echo ""
echo "Next steps:"
echo "1. Visit: https://github.com/FindDataTechnology/platform/actions"
echo "2. Watch the 'image' workflow run"
echo "3. Wait for completion (5-10 minutes)"
echo ""
echo "After deployment:"
echo "- Visit your production URL"
echo "- Test cluster creation API"
echo "- Check monitoring endpoints"
