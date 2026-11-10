# schema-migrations Specification

## Purpose

定义平台与 cell 数据库的 schema 演进纪律：迁移是有序、幂等、可重跑的，且每一步只对自己
声明的那一处结构负责。存在的理由是一次线上事故——cell 账本自带压缩过的历史，版本号会与
旧谱系相撞，于是「账本记过 N ⇒ N 的结构在」不成立；一条裸 `ALTER` 就足以让整格数据库
停用。本能力把「缺结构就补结构，而不是停止服务」写成可验收的规则。

## Requirements

### Requirement: 迁移不得因缺失的旧表停掉整个数据库

一次 schema 迁移 SHALL 只对它所声明的那一处结构负责：当它要 `ALTER` 的基础表在这份库里
不存在（账本记过该表的创建版本、表却被压缩/裁剪掉，即旧谱系 cell 库），该迁移 SHALL 先
把基础表就地重建为其创建迁移的形状，再施加自己的增量，而不是抛出 `no such table`。

任一迁移抛出未预期错误时，失败 SHALL 局限于该迁移，不得让整个数据库进入停用状态——一个
与 Chatwoot 无关的 cell 不能因为 Chatwoot 一张表缺失而丢掉会话、包、台账与凭据。

重建与增量两步 SHALL 幂等：在表与列都已存在的健康库上重复执行 SHALL 不改变任何数据、
不改写既有行。

#### Scenario: 旧谱系库缺表仍能启动

- **WHEN** 一份 cell 库的 `schema_migrations` 记为 v37、`user_chatwoot_credentials`
  表不存在，进程带着含 v100 的代码启动
- **THEN** v100 重建该表并补上 `chatwoot_user_id` 列，迁移继续向后应用
- **AND** `isDbReady()` 为真，该 cell 的其余功能可用

#### Scenario: 健康库升级不丢数据

- **WHEN** 表已存在且有一行 Chatwoot 凭据、但缺 `chatwoot_user_id` 列
- **THEN** 迁移后该行仍在、token 字节不变，且新列为 NULL
- **AND** 在表与列齐备的库上重跑该迁移不产生任何数据变更
