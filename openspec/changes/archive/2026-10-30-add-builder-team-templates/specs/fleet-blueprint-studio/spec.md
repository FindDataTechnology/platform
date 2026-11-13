# fleet-blueprint-studio delta

## ADDED Requirements

### Requirement: NL 起草可经蓝图构造师工具面直通草稿池

自然语言起草 SHALL 支持两条等价通道，产物进**同一**草稿池、走**同一**校验链：
①既有复制粘贴通道（studio 提示词 → 外部会话 → 粘贴回池）保留不删；②**builder 直通通道**——
蓝图构造师官方 pack 经其 bundled 工具面（`blueprint_draft`/`blueprint_validate`/`blueprint_save`，
openspec: builder-team-templates）在对话内组稿、校验、落池。直通通道 SHALL 复用既有校验链与错误
原文语义（禁第二套校验），落池的草稿与粘贴草稿在构造间 SHALL 无差别可见、可继续编辑；未过校验
的草稿 SHALL 拒绝落池。直通通道 SHALL NOT 改变批准闸纪律：未经主人在构造间明确批准，草稿不落地
为任何实体（既有「草稿不落库」纪律原样覆盖工具面来稿）。

#### Scenario: 两条通道产物同池同权

- **WHEN** 同一场景分别经粘贴通道与构造师直通通道各产一份草稿
- **THEN** 两份草稿在构造间草稿池无差别呈现，编辑、校验、批准、铸造路径完全一致

#### Scenario: 直通来稿同受批准闸约束

- **WHEN** 构造师经工具面落池一份草稿，主人未批准
- **THEN** 市场、铸造仓与实例化路径零新增，与粘贴通道的未批准草稿纪律逐字相同

#### Scenario: 粘贴通道不删

- **WHEN** 用户在无蓝图构造师安装的 cell 打开蓝图构造间
- **THEN** 复制提示词→粘贴回池的既有通道照常可用
