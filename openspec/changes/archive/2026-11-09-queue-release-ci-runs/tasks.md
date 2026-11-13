# Tasks — queue-release-ci-runs

- [x] 1.1 `ci.yml`：`cancel-in-progress: true` → `false`，并加注释说明 26 分钟单测 + 多人并行出片的实测背景
- [x] 1.2 `image.yml`：同上（半完成的镜像 push 比排队更糟）
- [x] 1.3 : 排队行为在下一轮快照上验证（连推时第二个应为 queued） 验证：连推两次快照，确认第二个 run 处于 `queued` 而非把第一个 cancel；第一个跑完第二个才开跑
- [x] 1.4 文档：`DEPLOY.md` 出片段补一句"出片车间的 CI 是排队的，连推会等"
