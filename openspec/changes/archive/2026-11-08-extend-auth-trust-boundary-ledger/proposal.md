# 信任边界台账补全：门外的身份入口与豁免前缀

## Why

`auth` 的「Trust boundary and scope」已经要求**内部桥接**逐条登记在一张表里
（回环 + 无代理身份两半判据，10 条）。但那次只登记了桥。审计其余部分的结论是：
真正的信任边界由 23 条以上入口共同构成，其中**只有 10 条在 spec 里**——剩下的
分两类，都没有契约占位：

1. **11 条 auth 门整体豁免的前缀**（`AUTH_EXEMPT_PREFIXES`）。豁免的理由每条都
   写在代码注释里（各自自称鉴权，或本就是无数据的公开资产），但 spec 一条都没
   记。这正是本次在 `/local-registry/` 上抓到真缺陷的土壤：注释写「只对回环
   开放」，代码一次地址检查都没有——因为没有契约要求它证明自己。
2. **门外 / 门内的其它身份入口**：网关身份头 + 网关密钥、Logto 签名 cookie、
   MP Bearer、配对设备 Bearer、auth 关闭时的隐式机主、`requireMcpManage` 的
   cell-owner 旁路、role/layout 头的同边界携带。这些是平台「谁是谁」的全部来源，
   却只散落在注释与实现里。

同一批还抓到一处可比性问题：三条共享密钥门里，bot-relay 走 `secretMatches`
（常量时间），trial-exec 内联 `timingSafeEqual`，而 `pack-usage` 用 `!==`。

## What Changes

- `openspec/specs/auth/spec.md` R7 扩写成完整台账：豁免前缀表（11 条，每条写
  自鉴权机制与失败姿态）+ 身份入口表（10 类，每条写凭据、生效条件、失败姿态），
  并要求：豁免前缀 MUST 自鉴权（无凭据的只能是「无数据公开资产」）、共享密钥
  MUST 走单一常量时间比较实现、新增/放宽任一入口 MUST 视为放宽信任边界。
- `server/routes/pack-usage.js`：`!==` → `secretMatches`（行为等价，比较方式对齐）。
- `scripts/test-auth-trust-boundary.mjs`：台账自检（代码里的前缀集合与 spec 表
  逐条对齐；每条前缀在代码里确有自鉴权痕迹），防止表与实现再次漂移。

非目标：不改任何门的判据与现有行为；不新增凭据类型；不做身份归一化（另一议题）。

## Impact

- 纯文档 + 一处比较方式对齐；无部署面变化。
- 新增的自检脚本会让「加了豁免前缀却不在 spec 表里」直接变红。
