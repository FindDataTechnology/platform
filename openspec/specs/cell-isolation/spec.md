# cell-isolation Specification

## Purpose
每个租户 cell 在凭据、文件系统、数据、资源与日志五个面上互不可冒充、互不可读、互不可拖垮，使平台在多租户安全评审中能被称作「隔离」而不是「约定」。

## Requirements

### Requirement: 每个 cell 只认自己的凭据

网关为每个 cell 签发**只属于该 cell** 的凭据，cell 侧只接受自己的那一个；被某个 cell 读到的
凭据 SHALL NOT 能冒充任何其它 cell。凭据的校验主体 SHALL 是「这是哪个 cell」，
MUST NOT 只回答「这是某个 cell」。

#### Scenario: 偷到 A 的凭据也冒充不了 B

- **WHEN** 租户 A 的 cell 进程读到自己的凭据，用它携带 `x-forwarded-email: <租户 B 的用户>` 调 B 的 API
- **THEN** B 的 cell SHALL 拒绝该请求（凭据不属于 B）
- **AND** 网关侧的审计记录 SHALL NOT 显示这是 B 的一次正常调用

#### Scenario: 网关是唯一能签发凭据的一方

- **WHEN** 某 cell 进程试图为另一个 cell 生成或复用凭据
- **THEN** 它 SHALL NOT 具备这样做的手段（凭据不由 cell 侧环境里的共享秘密派生）

### Requirement: 每个 cell 的数据目录对兄弟 cell 不可读

每个 cell 的数据根 SHALL 有独立的文件系统属主与 `700` 权限；一个 cell 的身份
SHALL NOT 能读取另一个 cell 的 `app.db`。容器级共享的进程命名空间 SHALL NOT 让
一个 cell 通过 `/proc` 越过这条边界。

#### Scenario: 直接抄邻居的库

- **WHEN** 以 A 的 cell 用户身份执行 `cp /data/cells/<B>/data/data/app.db /tmp/`
- **THEN** 该操作 SHALL 因权限被拒绝
- **AND** A 的 cell 仍能正常读写自己的 `app.db`

#### Scenario: 经由 /proc 找邻居的端口

- **WHEN** A 的 cell 从 `/proc/net/tcp` 或 `/proc/<pid>/cmdline` 取得 B 的回环端口并调用
- **THEN** 该调用 SHALL 因凭据不属于 B 而被拒（见上一条），`/proc` 可见性本身不构成信任

### Requirement: 角色写入的身份取自凭据而不是请求体

写角色的路由 SHALL 从调用方凭据推导目标身份，MUST NOT 接受请求体里的 `email` 作为目标。
角色写入 SHALL 只改调用方自己的角色。

#### Scenario: 改别人的角色

- **WHEN** 一个 cell 提交 `{"email":"victim@corp.com","roles":["finance"]}` 到自服务角色写入接口
- **THEN** 接口 SHALL 忽略（或拒绝）该 `email` 字段，改动 SHALL 只落在调用方自己的身份上
- **AND** 受害者的角色在写入前后 SHALL 保持一致

#### Scenario: 正常自改仍然可用

- **WHEN** 调用方提交的角色变更目标就是它自己
- **THEN** 变更 SHALL 生效，且审计记录 SHALL 能指出是哪一个身份发起的

### Requirement: 匿名入站路径的定位不随租户数线性放大

无需登录即可到达的路由，其「这条入站消息属于哪个 cell」的定位 SHALL 是**一次索引查询**或
等价的常数级操作；MUST NOT 为每个请求逐个打开所有 cell 的数据库。未知标识 SHALL 在触碰
任何租户数据之前被拒绝。

#### Scenario: 用随机 botId 打满网关

- **WHEN** 匿名调用方以每分钟十个的速率提交随机的 `botId`
- **THEN** 每次请求打开的数据文件数 SHALL 与 cell 总数无关（不得超过常数）
- **AND** 未知标识 SHALL 在读取任何 cell 数据库之前返回 404

#### Scenario: 已知 bot 的正常入站

- **WHEN** 一个真实存在的 `botId` 带着正确 secret 入站
- **THEN** 消息 SHALL 被投递到它所属的那个 cell
- **AND** 错误的 secret SHALL 得到 403，且 SHALL NOT 造成该 cell 被无谓启动

### Requirement: 每个 cell 的数据有备份且恢复步骤成文

每个 cell 的持久化数据库 SHALL 有定期备份、SHALL 有保留策略、SHALL 有写下来的恢复步骤；
备份 SHALL 覆盖全部 cell，而不只是市场目录那一个小库。

#### Scenario: 单节点不可恢复

- **WHEN** 承载若干 cell 的节点永久失去磁盘
- **THEN** 每个受影响 cell 的数据库 SHALL 能从备份恢复，且恢复步骤不需要重新发明

#### Scenario: 新 cell 自动进入备份

- **WHEN** 新建一个 cell
- **THEN** 下一次备份轮次 SHALL 自动包含它（不依赖人工把目录加进清单）

### Requirement: 活库备份用数据库自带的备份方式

对正在写入的 SQLite 库做备份时 SHALL 使用数据库自身的备份机制（`.backup` 或等价），
MUST NOT 以逐文件拷贝的方式取主文件与 `-wal`/`-shm`。

#### Scenario: 写入落在三文件之间

- **WHEN** 备份过程中有一笔写入落库
- **THEN** 产出的备份 SHALL 能被打开且事务边界自洽（不出现无法打开或静默回退最新事务）

### Requirement: 生产清单必须告诉网关租户数据在哪

生产部署清单 SHALL 在运行网关的容器上设置 `CELL_DATA_ROOT` 指向持久卷；
网关在**生产模式**下启动且该变量缺失时 SHALL 拒绝启动并给出显式错误，MUST NOT 回落到
容器可写层里的相对路径。

#### Scenario: 清单漏了变量

- **WHEN** 生产模式启动且 `CELL_DATA_ROOT` 未设置
- **THEN** 网关 SHALL 以非零退出码退出并点名缺失的变量
- **AND** SHALL NOT 在任何相对路径下开始写入租户数据

#### Scenario: 发布不丢数据

- **WHEN** 按生产清单重新发布
- **THEN** 租户数据目录 SHALL 仍指向持久卷，发布前后 cell 数据 SHALL 保持一致

### Requirement: 迁移失败必须是致命的

数据库初始化时，**迁移**失败 SHALL 让进程以非零码退出（由 supervisor 重启、由探针发现）；
「文件根本打不开」这条路 MAY 保持容忍。就绪面 SHALL 反映数据库是否可用，MUST NOT 只看
agent 是否就绪。

#### Scenario: 迁移抛错

- **WHEN** cell 启动时某个迁移抛错
- **THEN** 进程 SHALL 退出（非零），SHALL NOT 继续 serving
- **AND** 探针 SHALL 将本 cell 判为未就绪

#### Scenario: 数据库掉线后不再假装健康

- **WHEN** 运行期数据库句柄丢失
- **THEN** 就绪接口 SHALL 返回未就绪，而不是 200

### Requirement: 平台容器声明资源上限且空闲 cell 会被回收

承载网关与全部 cell 的容器 SHALL 声明内存上限（与节点规模相称），空闲 cell SHALL 被回收
而不是无限期常驻；准入闸在取不到用量时 MUST NOT 默认放行。

#### Scenario: 单个租户的昂贵任务

- **WHEN** 一个租户发起把内存吃满的任务
- **THEN** 触发的 SHALL 是该容器自己的上限与回收，而不是整台节点被内核或 kubelet 杀掉
- **AND** 其它租户的 cell SHALL 保持可用

#### Scenario: 采样失败

- **WHEN** 内存采样器读不到值
- **THEN** 准入判断 SHALL 按失败处理（拒绝新的唤醒），MUST NOT 视为无限制

### Requirement: 日志不携带租户消息正文

入站消息处理路径 SHALL 只记录形状（消息 id、长度、chat key 的散列、解析结果），
MUST NOT 把消息正文或原始载荷片段写进日志。

#### Scenario: 正常入站

- **WHEN** 一条消息入站并被解析
- **THEN** 日志行 SHALL 只包含可用于排障的形状字段
- **AND** 该行的任何部分 SHALL NOT 能还原消息正文

### Requirement: 销毁失败即中止

销毁 cell 时，表示「已销毁」的登记写入 SHALL 成功后才删除数据；登记写失败时
SHALL 中止删除并返回显式错误，MUST NOT 继续删除数据。

#### Scenario: 登记库写不进去

- **WHEN** 销毁流程中登记写入失败（库被锁、磁盘满）
- **THEN** 数据 SHALL NOT 被删除，接口 SHALL 返回错误
- **AND** 随后的请求 SHALL NOT 因此得到一个「全新空 cell」

#### Scenario: 正常销毁

- **WHEN** 登记写入成功
- **THEN** 数据被删除，且后续请求不会再拉起该 cell
