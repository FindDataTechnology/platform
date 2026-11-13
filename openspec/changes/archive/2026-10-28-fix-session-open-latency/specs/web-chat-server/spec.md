## ADDED Requirements

### Requirement: 窗口化转录首帧经压缩传输

服务端与客户端之间的 WebSocket 连接 SHALL 协商 `permessage-deflate`（RFC 7692）。首帧 `session_loaded` 的载荷包含折叠工具块（`blocks`），可见文本只占字节数的 <1%，其余为浏览器折叠后不渲染的工具输出；压缩使该载荷在 wire 上按字节传输，**不改变消息语义、不丢失折叠块、不引入客户端改动**。

#### Scenario: 折叠工具块的首帧按字节传输

- **WHEN** 会话有 50 条消息，合计约 1.3MB JSON（其中 `blocks` 约 99.2%）
- **THEN** 服务端通过 permessage-deflate 帧传输，客户端收到完整载荷，折叠块保留
- **AND** 同一载荷在未压缩时约 1.3MB，压缩后约 100-200KB（视 zlib 窗口）

#### Scenario: 小帧跳过压缩

- **WHEN** 载荷 < 1KB
- **THEN** 服务端不为其建 zlib 上下文（`threshold: 1024`），开销为零

### Requirement: 压缩不改变分页契约

`load_earlier` → `session_page` 分页契约 SHALL 保持不变：`beforeSeq` 游标、升序返回、`hasMore` 布尔值、session 归属校验均不变。`permessage-deflate` 是传输层细节，分页逻辑与客户端窗口大小无关。

#### Scenario: 压缩下分页仍止于首条

- **WHEN** 客户端请求比当前窗口更早的页面，服务端返回空页 + `hasMore: false`
- **THEN** 客户端收到完整载荷（无论是否压缩），分页正常结束