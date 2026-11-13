## 1. 实现

- [x] 1.1 configWriteCore：model 段记 `modelRequested`；GET entry 后、PUT 前插 roster 门（entry.runner_id??默认行→boardNow→modelChoiceError；400 MODEL_NOT_IN_ROSTER）

## 2. 测试

- [x] 2.1 test-agent-serving.mjs 配置面增例（env 设还+板桩）：lane 过+不在册→400 无 PUT；在册→200；null 清不走门；板断→照写（降级开放）；既有配置面用例零回归
- [x] 2.2 全量关联回归（agent-serving/deploy-lock/deploy-roster-gate/fleet-report/scheduler）

## 3. 部署与生产验证

- [x] 3.1 law-ai platform-images 线出片 → ccr 实证 → GitOps 滚 facet 面
- [x] 3.2 生产复证：wx-alpha model 清 null（回默认在册模型）→ 真回合正常应答；负路径 model 写不在册 → 400 MODEL_NOT_IN_ROSTER
- [x] 3.3 复扫全条目 effective_model × 花名册：零不在册

## 4. 收尾

- [x] 4.1 案例卡注记（配置面闭环+现患清零；余采集器项）+ openspec 归档 + 记忆

## 5. 生产连带（切片中发现的真缺陷，同批根治）

- [x] 5.1 **配置写 URL 自环缺陷**：GET-merge-PUT 把公网显示 URL 回写（PUT 422→register 兜底静默落盘）→ registry nginx proxy_pass 自指 → 条目 A2A 断路。生产实录 4 条目（wx-alpha/data-scout/brief-writer/market-flash，含本片验证写触发的 2 条）。修复：PUT 前按宿主 fleet 几何重建 origin url + provider/version 归一（调度器同款写形状）；测试钉死回归形状（stub 显示 URL 进、origin 出）
- [x] 5.2 数据修复：4 条目 PUT 回正确 origin（端口取 runner /health 实绑值）；nginx 自环审计归零；写后复发审计归零（正路径复写后仍 0 自环）
- [x] 5.3 wx-alpha 现患链路修复实证：错误类别从链路 401/404 迁移为 LLM 上游暂态（503/429，外部窗口）；上游恢复后的内容回执随自然流量补。同批复核今晨计费修复：两笔 503 回合 outcome=error/minutes 0/waived ✓
