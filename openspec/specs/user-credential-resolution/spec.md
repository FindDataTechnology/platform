# user-credential-resolution Specification

## Purpose
TBD - created by archiving change add-user-supplied-credentials. Update Purpose after archive.

## Requirements

### Requirement: 凭据按三层级联解析，缺省逐层继承

系统 SHALL 以单一解析路径回答「某用户在某个 MCP server 的某个工具上该用哪份凭据」，
解析顺序 SHALL 为 tool 级覆盖 → server 级覆盖 → user 级默认。某一层未提供该字段时
SHALL 继承下一层；三层都没有时 SHALL 判定为「无凭据」，MUST NOT 猜测或回退到他人凭据。

LLM 车道与 MCP 车道 SHALL 使用同一解析路径（同一份级联语义），区别仅在于结果落到
哪个载体（LLM 落凭据存储与 provider 配置，MCP 落条目 headers/env）。

#### Scenario: tool 覆盖优先于 server 与 user
- **WHEN** 同一 server 的同一工具在三层都有 `api_key`
- **THEN** 生效的是 tool 级的值

#### Scenario: 缺失层继承
- **WHEN** 只配置了 user 级默认，server 与 tool 层为空
- **THEN** 该 server 与该 server 的所有工具都用 user 级值

#### Scenario: 三层皆空
- **WHEN** 三层都没有该字段
- **THEN** 判定为无凭据，携带该凭据的条目 SHALL 按既有语义被省略，MUST NOT 用他人凭据填充

### Requirement: 凭据按所有者隔离，跨用户不可见

每一份 per-user 凭据 SHALL 绑定所有者身份，且只有该所有者的运行时解析能看到它。
MUST NOT 出现「A 的凭据出现在 B 的运行时配置里」，也 MUST NOT 因为某用户未配置而
回退到部署级共享凭据（除非该 server 明确是共享凭据形态）。

#### Scenario: 两个用户各自的 key 互不可见
- **WHEN** 用户 A 与 B 为同一 server 配置了不同的 key
- **THEN** A 的运行时配置只含 A 的 key，B 的只含 B 的

#### Scenario: 未配置的用户不继承他人
- **WHEN** 用户 C 未配置该 server 的任何凭据，而 A、B 已配置
- **THEN** C 的该条目按既有语义省略或走平台默认，MUST NOT 拿到 A 或 B 的凭据

### Requirement: per-user 凭据加密存储

新增的 per-user 凭据存储在落盘时 SHALL 加密，明文 MUST NOT 出现在数据库文件、
日志、或任何返回给客户端的响应里。写入接口 SHALL 只回传「已配置/未配置 + 元信息」，
MUST NOT 回传凭据值本身。

#### Scenario: 读取接口不带凭据值
- **WHEN** 客户端读取自己的凭据配置
- **THEN** 返回体含 `hasKey: true` 之类的元信息，不含 key 字符串

#### Scenario: 日志不含凭据
- **WHEN** 解析器遇到凭据并在日志里记录解析过程
- **THEN** 日志只记录「用了哪一层、字段名」，不记录值
