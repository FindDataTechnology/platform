# Tasks: add-runner-route-key-match

## 1. 匹配规则改造

- [x] 1.1 `server/cron-runner.js` `runnerEntryFor`：谓词改 path 尾段 agent 键匹配（`agentKeyOf(entry)`：
  `path` 末段，归一与 `job.preset` 同律；快照条目缺 path 时从 `url` 的 `/agent<path>/` 形态回退解析）
- [x] 1.2 命中 ≥2 条 → 返回 null 并置 `job.carrierFallback = "runner-ambiguous"`（日志 warn 列候选 path）；
  命中 0 条维持 `runner-no-entry`；调用侧改写与 fail-open 通道零改动

## 2. 测试

- [x] 2.1 test-fleet-carrier：path 尾段命中用例（伪 registry 快照 entry 带 path + persona 成员裸键 →
  远端改写发生、preset=entry.id）
- [x] 2.2 test-fleet-carrier：跨包同名歧义用例（两条同键 entry → fail-open runner-ambiguous、不改写）
- [x] 2.3 既有 no-entry 用例原样保绿；全量回归 + lint

## 3. 出片与验收

- [x] 3.1 公开门（快照仓 CI+image 双绿）→ 池出片 → relay/ccr → GitOps 双面 bump（bump 前核祖先）
- [x] 3.2 真机验收：取证舰队 persona 成员（已装包 serving 部署的 agent 键，如 wx-alpha——需该包对走查
  账号可见）+ carrier=runner → 命中远端执行器 `carrier=remote`；跨包同名键 → runner-ambiguous
- [ ] 3.3 台账 §15.x + 双分支收正 + 归档（主 spec 同步律：MODIFIED 携完整需求块）
