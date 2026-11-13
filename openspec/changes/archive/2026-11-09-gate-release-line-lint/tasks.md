# Tasks — gate-release-line-lint

- [x] 1.1 `.githooks/pre-push`：取 `git diff --name-only @{push}..HEAD`（退化到 `HEAD~1..HEAD`），过滤 `web/src|packages|server|scripts|e2e|test` 下的 `.ts/.tsx/.js/.mjs`，跑 `npx biome check <files>`；红则 exit 1 并打印「改这些文件 / 或 SKIP_LINT_HOOK=1 逃生」
- [x] 1.2 `package.json` 加 `"prepare": "git config core.hooksPath .githooks || true"`，保证 clone 后自动生效；验证：新克隆里 `git config core.hooksPath` = `.githooks`
- [x] 1.3 逃生阀：`SKIP_LINT_HOOK=1` 时跳过并打印一行警告；验证：故意制造一处违规，带逃生阀可推、不带则被拒
- [x] 1.4 CI：`ci.yml` 新增「Lint（推送范围）」步，用同一个脚本（`scripts/lint-changed.mjs`），避免本地与 CI 两套判据；验证：故意推一处违规，CI 在 lint 步红且指名文件
- [x] 1.5 抽出 `scripts/lint-changed.mjs` 供钩子与 CI 共用；验证：两个入口对同一改动给出同一结果
- [x] 1.6 `DEPLOY.md` 出片段补一句；验证：读一遍能照做
- [x] 1.7 回归：在干净树上推送一次（无改动文件）不得误报；验证：空推送直接过
