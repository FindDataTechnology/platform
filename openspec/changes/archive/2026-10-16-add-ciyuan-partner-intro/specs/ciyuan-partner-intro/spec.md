## ADDED Requirements

### Requirement: 伙伴介绍材料存在且口径受控

詞元 SHALL 有一份仓内维护的合作伙伴介绍材料（试用指南形态：是什么/入口/快速上手/
能力清单/计量与计费/支持）。材料中的端点路径与计量单位 SHALL 与面板车道页（
`/lanes`）一致；SHALL NOT 出现随分组变化的价目数字、内部治理细节（谱系/月度窗/
缝点）或上游供应商身份。调用地址 SHALL 使用 `router.finddatatech.cloud`。

#### Scenario: 口径与车道页一致

- **WHEN** 对照介绍材料的端点与计量单位与面板 `/lanes` 页
- **THEN** 两者的端点路径与计量表述一致，无相互矛盾

#### Scenario: 无内部信息泄露

- **WHEN** 检查介绍材料全文
- **THEN** 不含价目数字、不含上游供应商名称、不含谱系治理细节
