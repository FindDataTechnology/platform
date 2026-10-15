# ciyuan-partner-intro Specification

## Purpose

萬星·词元面向合作伙伴的试用介绍材料：仓内维护、包含测试账号与快速上手，
端点与计量口径与面板 `/lanes` 页一致，且不含内部治理细节与随分组变化的价目。

## Requirements

### Requirement: 伙伴介绍材料存在且口径受控

詞元 SHALL 有一份仓内维护的合作伙伴介绍材料（试用指南形态：是什么/入口/快速上手/
能力清单/计量与计费/支持）。材料中的端点路径与计量单位 SHALL 与面板车道页（
`/lanes`）及首页视频能力条目一致；SHALL NOT 出现随分组变化的价目数字、内部治理
细节（谱系/月度窗/缝点）或上游供应商身份。调用地址 SHALL 使用
`router.finddatatech.cloud`。

#### Scenario: 口径与车道页一致

- **WHEN** 对照介绍材料的端点与计量单位与面板 `/lanes` 页
- **THEN** 两者的端点路径与计量表述一致，无相互矛盾

#### Scenario: 视频能力入册

- **WHEN** 检查介绍材料能力清单与快速上手
- **THEN** 含视频生成条目（`POST /v1/contents/generations/tasks` 创建、`GET` 同路径轮询）与计量口径，与首页视频条目表述一致

#### Scenario: 无内部信息泄露

- **WHEN** 检查介绍材料全文
- **THEN** 不含价目数字、不含上游供应商名称、不含谱系治理细节
