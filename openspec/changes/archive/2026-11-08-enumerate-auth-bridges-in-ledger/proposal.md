# enumerate-auth-bridges-in-ledger

## Why

`openspec/specs/auth/spec.md` 「Trust boundary and scope」 要求得极明确：

> Each bridge SHALL be enumerated in one table with the identity it stamps, its
> verb/path scope, and the route-side attribution that keeps a forged caller from
> acting as a name it supplies.

**那张表不在 spec 里。** 代码侧早就有：`server/auth.js` 的 `INTERNAL_BRIDGES` 是一张
10 行表（身份 / 匹配器 / 归属说明），注释还写着「Every bridge the gate opens, in one
table」。台账自检 `scripts/test-auth-trust-boundary.mjs` 只校验了两张表
（8 条豁免前缀、10 类身份入口），**没有校验桥接表**——因为 spec 里没有它，测试无从比对。

这正是审计的老毛病：门槛只活在代码注释里，两边漂移时没有任何东西会红。而桥接是
最危险的一类门口——它把身份直接「盖章」成 `*@internal`，越过常规鉴权闸。少写一条，
就等于多了一扇没人审计的门；反过来，表里多一条而代码没删干净，也会让人误以为那条
路已关。

顺带一处口径差：`INTERNAL_BRIDGES` 里八个桥的 `match` 只覆盖了 path 的一半语义
（谁在什么动词下算桥），spec 若不写，后来者只能去读十个闭包。

## What Changes

- **spec 补桥接表**：在「Trust boundary and scope」的桥接段落之后，按实现逐条列出
  10 个桥的**盖章身份 / 动词·路径范围 / 路由侧归属**，并写明它们共用同一个
  `isInternalChild` 守卫（loopback 且无 `x-forwarded-email`），所以新桥不可能带着更弱的
  调用者判据进来。
- **「台账与代码一致」场景扩写**：从「新增豁免前缀或身份入口要同批更新表」扩成
  「新增豁免前缀、身份入口**或内部桥**」，并把判据写成「实现集合与文档集合分叉时检查必须失败」。
- **导出单一真源**：`server/auth.js` 把 `INTERNAL_BRIDGES` 导出（与
  `AUTH_EXEMPT_PREFIXES` 同一理由——台账自检需要一个可读的真源，而不是解析注释）。
- **自检扩围**：`scripts/test-auth-trust-boundary.mjs` 增加桥接表与
  `INTERNAL_BRIDGES` 的逐行对照（身份 + 路径集合），并断言每行都有三段非空（身份 /
  范围 / 归属），空归属正是「伪造调用者可自报身份」那种缺陷的温床。

## Capabilities

### Modified Capabilities

- `auth`: 「Trust boundary and scope」新增内部桥接表（10 行）并扩写一致性场景；桥的
  增删改从「代码里的一件事」变成「同批改文档、否则自检红」。

## Impact

- **spec**：`openspec/specs/auth/spec.md`（经本 change 归档生效，不手改）。
- **代码**：`server/auth.js` 一行 `export`（`INTERNAL_BRIDGES`），行为零变化。
- **测试**：`scripts/test-auth-trust-boundary.mjs` 新增桥接对照用例；现有 4 例保持绿。
- **风险**：纯台账与自检，无运行时行为变化；出片不影响。

## 非目标

- 不改任何桥的匹配器、盖章身份或守卫（这一版只把它们写下来并钉住）。
- 不改豁免前缀表与身份入口表的内容（它们已是既有台账）。
- 不新增桥、不扩大任何桥的动词/路径范围。
- 不动网关侧（`gateway/`）的转发实现。
