# Design — add-facet-cli-update（F2.3）

## Decisions

### D1 — 记录是唯一事实源
技能 frontmatter 不带版本（registry 元数据面才有），扫描不可靠——install 落
installed.json（数组，键=packId+target+scope+project 复合去重）。F2.1 之前的手工安装
不在记录里：update 接受显式 packRef 覆盖此场景（跑一次 install 即入册）。

### D2 — update 复用 install 的写路径
抽 `installSnapshot(detail, {dir})` 小函数（技能下载+落盘），install 与 update 共用——
「更新的字节=全新安装的字节」由构造保证。MCP 配置不动（连接与版本无关）。

### D3 — 零订阅副作用
update 只 GET 详情+技能 md（与 install 同一面），不触碰任何订阅/运行时端点——
快照模型不动（伞文档 F2 定语）。

## Risks / Trade-offs

- 记录文件手工删除/换机=失联：update 无参时空转（诚实打印「无记录」）；重跑 install 即恢复。
