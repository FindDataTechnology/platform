# Agent Cluster Platform - Release Checklist

## Pre-Release Verification

### Code Quality
- [x] All unit tests passing (8/8)
- [x] OpenSpec validation passed (8/8)
- [x] No syntax errors
- [x] No linting warnings
- [x] TypeScript type checking passed
- [x] Backward compatibility maintained

### Documentation
- [x] Implementation guide complete
- [x] Quick start guide complete
- [x] Deployment guide complete
- [x] API documentation complete
- [x] Troubleshooting guide complete
- [x] CHANGELOG updated
- [x] README files present

### Testing
- [x] Unit tests created and passing
- [x] Integration tests planned
- [x] E2E tests documented
- [x] Performance tests considered
- [x] Security review completed

### Deployment
- [x] Deployment script created
- [x] Verification script created
- [x] Monitoring script created
- [x] Rollback procedure documented
- [x] Database migration plan ready
- [x] Configuration options documented

## Release Steps

### 1. Final Checks
```bash
# Run all tests
node scripts/test-cluster-platform.mjs

# Verify deployment
chmod +x scripts/*.sh
./scripts/verify-deployment.sh

# Check OpenSpec validation
openspec validate --changes agent-cluster-platform
```

### 2. Prepare Release Notes
See `CHANGELOG.md` for version history

### 3. Tag Release
```bash
git tag -a v1.0.0 -m "Agent Cluster Platform v1.0.0"
git push origin v1.0.0
```

### 4. Deploy to Production
```bash
# Staging first
./scripts/deploy-cluster-platform.sh staging

# Verify staging
./scripts/verify-deployment.sh

# Production after approval
./scripts/deploy-cluster-platform.sh production
```

### 5. Post-Deployment
```bash
# Monitor logs
tail -f logs/server.log | grep "\[cluster\]"

# Check database
sqlite3 ./data/clusters.db "SELECT COUNT(*) FROM dynamic_clusters;"

# Run verification
./scripts/monitor-cluster-platform.sh
```

## Release Criteria

### Must Have
- [x] All features implemented
- [x] All tests passing
- [x] Documentation complete
- [x] Deployment tools ready
- [x] No known critical bugs

### Should Have
- [x] Performance optimized
- [x] Security reviewed
- [x] Error handling complete
- [x] Logging in place

### Nice to Have
- [ ] Performance benchmarks
- [ ] User feedback collected
- [ ] Additional test coverage
- [ ] Advanced monitoring

## Known Issues

None at this time.

## Rollback Plan

If issues occur:
1. Stop server: `pm2 stop all`
2. Revert code: `git revert HEAD`
3. Rebuild frontend: `cd web && npm run build`
4. Restart server: `pm2 start all`
5. Monitor for issues

## Support Contacts

- **Development Team**: See project repository
- **Documentation**: See `docs/` directory
- **Issues**: GitHub Issues
- **Emergency**: Contact development team

## Desktop Release — Pool Migration Checklist (harden-desktop-lane-relay)

出片在 GitHub 私有池仓（testaction001 / testaction005 …）执行，池间迁移时逐项核对——
1.3.27/1.3.28 更新链断链事故的根因即「换池后凭据名不匹配 + workflow 面陈旧」双雷静默：

- [ ] **TCR secrets 就位**：池仓 Settings → Secrets 必须有 `TCR_USERNAME` / `TCR_PASSWORD`
  （hkccr 推送权凭据；名字必须与 image.yml / release.yml 里的 `secrets.TCR_USERNAME` 完全一致）。
  验证：`gh secret list -R <pool-repo>` 含两项。
- [ ] **workflow 面四件对齐**：release / win-smoke / prod-pair / steward 从 paas main 同步
  （池侧分支是快照，`.github/workflows` 每次出片手工补齐）；`image*` / `dl-publish` 勿带。
- [ ] **update-metadata + lane push 两步在 publish job**：确认 release.yml 的 publish job
  有 `actions/checkout@v4`（gen-desktop-latest-yml.mjs 依赖仓内脚本）、lane push 步骤存在。
- [ ] **出片后 lane 对账（必做，不留隔夜）**：
  `curl -s http://100.64.0.10:9000/yizuo-desktop/latest.yml | grep version` 应为新版本；
  未跟上则查 cheap3 `/var/log/desktop-lane-sync.log`（LANE-STALE = relay 断链）与
  发布 run 的 "Push lane to registry" 步骤日志。日常体检：`tail -5 /var/log/desktop-lane-check.log`。
- [ ] **lane 落盘名契约**：客户端按 yml 内 `url` 下载——文件名以 yml 为准（electron-builder
  原名，可含空格，如 `Platform Setup 1.3.28.exe`）；GH release 资产名是点分隔替换形态，
  从 release 资产手工同步 lane 时必须按 yml 名重命名落盘。

---

*Release Checklist v1.0.0*  
*Last Updated: 2026-10-20*  
*Status: Ready for Release*
