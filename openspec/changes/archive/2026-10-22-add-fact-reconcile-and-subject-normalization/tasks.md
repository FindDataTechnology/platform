# Tasks — add-fact-reconcile-and-subject-normalization

## 1. sidecar：事实层 reconcile 与 subject 双路

- [x] 1.1 `normalize_subject`（lowercase/NFKC/剥首尾标点/压空白）+ 表驱动 pytest（S1 机器标识符 7 对判同、大小写空白变体判同、明显不同判异）。验证：pytest 绿。
- [x] 1.2 事实层 reconcile 接线：fact 草稿 × fact 候选 → `build_fact_reconcile_prompt` → complete（audit_stage=distill_fact_reconcile）→ 修复版 `_parse_ops` → 关联即 supersedes 合并、无关联走限流 ADD。验证：pytest（mock provider 返回映射 JSON，断言 supersedes 链与调用留痕）。
- [x] 1.3 subject 语义判定：等值不过时一次 LLM 判定（提示词边界补丁 + json_repair 解析 `subject_matches` 节），判定行进 llm_calls（stage=distill_subject_judge、含理由）；判同并入归并、不改写 subject。验证：pytest（漂移对 fixture mock 判同 → 归并；判异 → 独立）。
- [x] 1.4 薄 fact 限流：`DISTILLER_FACT_MAX`（默认 2），超出以 fact_cap warning 记审计。验证：pytest 断言丢弃计数与 warning。

## 2. 评测与出片

- [x] 2.1 LLM 档 +2 场景（同主体合并 / 漂移对归并）+ eval-distill.mjs 断言扩展；本地真跑过（基线数字入档）。验证：eval PASS 且旧场景不回归。
- [x] 2.2 fd-build-channel 判路 → fd-memory-distiller 镜像重出（池 BUILD_DOCKERFILE 配方，用完还原变量）；digest 双证。验证：hkccr=ccr。
- [x] 2.3 fd-infra-deploy 滚 sidecar（fd-memory 不动）→ ArgoCD → 首批含 fact 蒸馏眼见（supersedes 链、subject_judge 审计、预算增幅 ≤~10%）。验证：生产 DB 查询 + 日志。

## 3. 收尾

- [ ] 3.1 台账（registry-maintenance §15.8 补记）+ 主 spec 同步（memory-distiller 1 MODIFIED + 1 ADDED）+ 归档（validate --specs 0 failed）。
