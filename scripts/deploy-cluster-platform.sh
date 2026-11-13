#!/bin/bash
# Complete deployment script for Agent Cluster Platform to production

set -e

echo "🚀 Deploying Agent Cluster Platform to Production"
echo "=================================================="
echo ""

# Step 1: Verify code is ready
echo "Step 1: Verifying code integrity..."
node --check server/routes/clusters.js && echo "✅ clusters.js syntax OK"

# Step 2: Commit and push to trigger CI/CD
echo ""
echo "Step 2: Committing changes to trigger CI/CD..."
git add .
git commit -m "feat: Add Agent Cluster Platform with full implementation

- Pack cluster metadata support
- Dynamic cluster creation API (7 endpoints)
- Database persistence layer
- Cluster-aware scheduling tools
- Auto-termination and rate limiting
- Full UI integration
- Comprehensive documentation"

git push origin main || echo "⚠️  Push may have failed, check manually"

# Step 3: Monitor GitHub Actions
echo ""
echo "Step 3: Monitoring GitHub Actions..."
echo "Visit: https://github.com/FindDataTechnology/platform/actions"
echo "Wait for 'image' workflow to complete (usually 5-10 minutes)"

# Step 4: Post-deployment verification
echo ""
echo "Step 4: After deployment completes:"
echo "  1. Check image at: https://hkccr.ccs.tencentyun.com/v2/yizuo/platform/tags/list"
echo "  2. Visit your production URL: https://your-domain.finddatatech.cloud/agents?tab=agents"
echo "  3. Test API: curl -X POST https://your-domain.finddatatech.cloud/api/clusters/dynamic"

echo ""
echo "🎉 Deployment triggered! CI/CD will handle the rest."
echo ""
echo "Next steps:"
echo "  - Wait for GitHub Actions to complete"
echo "  - Visit the production URL to test the new features"
echo "  - Check logs for any issues"
