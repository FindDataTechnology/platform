## Why

萬星·词元（FindDataRouter）已具备完整对外能力（chat 双协议 + 语音/重排/搜索三车道 +
统一账本），但**没有任何一份面向合作伙伴的介绍材料**。现有成熟形态是 `finddata/docs/`
下的「试用指南」体系（`wire-trial-intro.md`、`vaas-trial-intro.md`）：是什么 → 入口 →
测试账号 → 登录步骤 → 能做什么 → 计费与支持。词元需要同形态的一份，供发合作伙伴时
直接取用。

口径纪律（承接 ADR-0024 与官方 spec）：对外只讲**能力与口径**——产品名、入口、协议
形状、计量单位、鉴权链、硬顶机制；不讲内部治理（谱系 fork/月度窗/缝点）与具体上游
供应商身份（调度可变）。

## What Changes

- 新增 `finddata/docs/ciyuan-intro.md`——词元介绍/试用指南（无双语文档体系要求，
  单中文即可，与 wire/vaas 同格式）。
- 内容覆盖：是什么 / 入口与登录 / 快速上手（chat 双协议 + 三车道 curl）/ 能力清单 /
  计量与计费口径（含硬顶与错误码）/ 注意事项 / 支持联系方式。
- 不开测试账号（用户未指定伙伴名单；指南里留占位表格，开通后填入即可）。

## Capabilities

### New Capabilities

- `ciyuan-partner-intro`: 词元的伙伴介绍材料——一份仓内维护的介绍/试用指南，口径与
  面板车道页、首页、官网 app 页同源， SHALL NOT 含内部治理细节与上游供应商身份。

### Modified Capabilities

（无）

## Impact

- 仅新增一个文档文件（finddata/docs/ 非代码仓，无出片）。
- 未来开伙伴账号后，按指南占位表格填入即可发放。
