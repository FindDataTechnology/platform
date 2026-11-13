# tasks

- [x] 1. UI：PresetPublishFlow 确认步加「作为 AI 分身发布」区块——开关（默认关）+禁用态
      就地原因（无服务面角色/无技能）+多于一个服务面角色时的接待选定；开启时 manifest
      携带 `facade {reception, corpus: 全部技能名, delegation: [], stance: "hosted"}`
- [x] 2. 五语言 locale：`presetPublish.facade*` 键（开关标签/副文案/禁用原因/接待选定）
- [x] 3. e2e：preset-publish-flow 增两案——开启开关发布后 manifest 携带合法 facade 块
      （断言 mock 捕获的发布体）；零技能预设开关禁用且原因可见、发布照常不带块
- [x] 4. 验证面：typecheck/biome/check:locales 绿；e2e preset-publish-flow 全绿
      （含既有两案零回归）
- [x] 5. 上产：出片列车滚 platform/platform-demo/facet 三面；生产手验开关在位
      （预设发布流打开即见）；台账 §15.41
