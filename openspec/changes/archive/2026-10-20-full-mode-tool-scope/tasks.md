## 1. 全模式并集推导

- [x] 1.1 实现 `deriveFullModeToolScope()`：从 `installed_packs` 的 manifest 快照计算 `server → union(allowTools)`，任一引用无声明或标 `fullSurface` 时该 server 结果为"不过滤"；验证：新增单测覆盖四种输入（两 pack 取并、单 pack、无声明、fullSurface）
- [x] 1.2 无已装 pack 时返回 `null`；验证：单测断言 `deriveFullModeToolScope([]) === null`
- [x] 1.3 `writeMcpPatch` 在 full 模式分支使用并集而非 `null`；验证：`scripts/test-focus-overlay.mjs` 新增断言——full 模式写出的 `tool-filter.json` 含并集
- [x] 1.4 加环境开关 `FULL_MODE_TOOL_SCOPE`（默认 off）：off 时仍写 `null`；验证：开关 off 的合成结果与改动前逐字节一致（fixture 对拍）
- [x] 1.5 未声明即全量的安全阀：`[{allowTools: undefined}]` 必须产出"不过滤"；验证：单测显式断言不得出现 `{server: []}`

## 2. 每 server 全量覆盖

- [x] 2.1 `user_preferences` 读写 helper：键 `toolScope.fullSurface`，值为 server 名数组，空数组删键；验证：单测覆盖读、写、删、损坏值读作空
- [x] 2.2 覆盖在 `deriveScope` 之后应用：从并集/聚焦映射中删除被覆盖的 server；验证：单测断言覆盖后该 server 不在 `mcpTools` 里
- [x] 2.3 覆盖 API：`GET/PUT /api/mcp-tool-scope`（沿用现有鉴权与序列化变更路径）；验证：route 单测 + 一次真实调用
- [x] 2.4 设置→MCP 增加"完整工具面"开关并接入 API；验证：浏览器操作后 `user_preferences` 出现/移除对应键，下次合成生效
- [x] 2.5 开关文案与拒绝理由呼应（guard 提示指向该开关）；验证：文案走 i18n 四语言 key，`platform-tool-scope.js` 的拒绝文案含"设置→MCP"指引

## 3. 自建预设工具维度

- [x] 3.1 `user_presets` 加 `mcp_tools TEXT DEFAULT '{}'` 迁移；验证：`db.js` 的 ensureColumn 路径在旧库上幂等执行
- [x] 3.2 `createUserPreset` / `updateUserPreset` 接受并持久化 `mcpTools`；验证：`scripts/test-custom-presets.mjs` 新增往返用例
- [x] 3.3 `deriveScope` 的 custom 分支读取 `mcpTools`，缺省回落全模式并集（不再是 `null`）；验证：单测断言"未声明 → 并集"与"声明 → 精确集合"两侧
- [x] 3.4 预设编辑器提供工具选择器（复用 pack 编辑器的 catalog `tool_list` 来源），拒绝自由输入；验证：e2e 输入未在册名字被拒
- [x] 3.5 覆盖优先级：`fullSurface` 标记压过预设的收窄；验证：单测断言覆盖后 roster 为完整面

## 4. 测试

- [x] 4.1 单测：并集、安全阀、优先级、开关 off 的逐字节等价；验证：`node scripts/test-full-mode-tool-scope.mjs` 全绿
- [x] 4.2 集成：装两个 pack → full 模式 `tool-filter.json` 为并集 → 卸载一个 → 并集收窄 → 卸载最后一个 → 键消失；验证：脚本化断言四步的文件内容
- [x] 4.3 e2e（Playwright）：full 模式 roster 收窄、打开覆盖后恢复、自建预设收窄；验证：`e2e/pack-agent-scoping.spec.js` 扩三条用例通过

## 5. 灰度与验收

- [x] 5.1 依赖 finddata 侧回填完成，在 fd-prod 以 `FULL_MODE_TOOL_SCOPE=on` 打开；验证：`kubectl exec` 后 `probe-pack-scope.mjs` 报告的 full roster 工具数下降
      → 开关已 `on`（2026-10-20T09:35:43Z）；cell `1da519d4c1c0bf89` 的 `tool-filter.json` 于 09:36:29
      写出并集（airegistry-tools 5 + facet-market-mcp 5）。`probe-pack-scope.mjs` 的一次性合成拿不到
      cell 凭据（full roster 只剩 `websearch`），改用运行时物化文件 + registry `tool_list` 对照；
      见 `measurements.md` §1/§4。
- [ ] 5.2 `--turn-trace` 同题对比开关前后；验证：input+cacheRead 的 token 差与预期带一致（三 pack 场景 ≥60k 降幅）
      → **未做**：需要在真实用户 cell 上发两轮对话（WS 鉴权 + 替用户发消息），不适合在他人 cell 上执行；
      以「并集工具数 × 实测 schema token 比例」估算，cell `3fdc7b8e8ac03b68` 升级后 ≈60k token/轮
      （`measurements.md` §3）。
- [ ] 5.3 观察一周无用户报"工具不见了"（或全部由开关解决）后翻转默认值为 on；验证：默认值改动 + 一次重启后的合成日志
      → 观察窗自 2026-10-20 起算未满一周；代码默认值仍是 `off`，生产靠 env 开启。
- [x] 5.4 把数字写入 `measurements.md`；验证：文件含 full/focused 两模式的 roster 与 token 表
      → `measurements.md` 已含物化实证、当前/升级后并集对照、token 估算与复现命令。
