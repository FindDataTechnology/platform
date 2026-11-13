## 1. 内容填充（已完成，本 tasks 记录实证）

- [x] 1.1 三份官方助手包（wanxing/wire/facet）填 `i18n.en`：name/description/notes/guide 三步/
      skills[].description/agents[].name
- [x] 1.2 三份官方 pack（crm-desk-suite/finddata-facade/facade-builder）填 `i18n.en`，
      含 serving.card 文本（finddata reception / facade builder）
- [x] 1.3 五份团队种子填 manifest `i18n.en`（name/description/agents 名）+ `fleet.i18n.en`
      （fleet 名/成员岗名/KPI 标签）；架构师种子填 manifest `i18n.en`
- [x] 1.4 比率门（3:1）逐条过——六条英文描述超长被门逮住，压缩到阈值内（224→179 等）

## 2. 防漂移门（已完成）

- [x] 2.1 `scripts/test-official-locale-gate.mjs`：覆盖契约（name/description/notes/guide 整组/
      skills/agents 逐条）+ 种子双 overlay + zh 与结构键禁入；`test:unit` glob 自动纳入
- [x] 2.2 相关五套既有测试零扰动全绿（official-packs-lint / fleet-template-locale /
      fleet-templates / pack-locale / pack-locale-validation，73/73）

## 3. 验收

- [ ] 3.1 全量 `npm run test:unit` 绿（后台实证中）+ `openspec validate --strict` 绿 + locale 闸绿
- [ ] 3.2 生产验收（随下次发版/铸造）：en 访客 locale=en 读官方包详情全英文显示面；
      en 实化官方团队种子，团队名/岗名/KPI 标签英文、prompt 中文不变
- [ ] 3.3 与 `add-legacy-pack-rebrand` 合班发版：改名 + 副轨同一批新版本，避免官方资产连发两版
