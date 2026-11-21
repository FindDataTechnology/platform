# Content Pipeline / 内容流水线

## What this is

官方团队模板：周流水线内容工厂——主编周一主持选题会，选题策划立项、撰稿人周二至四成稿，审校为被动岗（受委托唤醒，演示成员间横向协作的唯一通道 delegation）。演示：周节奏流水线、被动岗受委托唤醒、文档工具面；编导段为 trigger(周一)→handoff 流水线（主编→策划→撰稿）+ 撰稿 dispatch 委托审校、审校 report 上行主编。铸造上架时 packId/agents 按铸造脚本补齐；本文件是清单真源，测试钉住其必须通过 fleet 段预校验。

Official team template: a weekly-pipeline content factory — the editor-in-chief chairs the Monday topic meeting, the topic planner greenlights proposals, and the writer finishes drafts Tuesday through Thursday; the reviewer is a passive role woken by delegation, demonstrating delegation as the only channel for lateral collaboration among members. Showcases: the weekly-rhythm pipeline, passive roles woken by delegation, and the document tool surface; the orchestrated segment is a trigger(Monday)→handoff pipeline (editor→planner→writer), plus the writer dispatching review work and the reviewer reporting up to the editor. When minted and listed, packId/agents are filled in by the mint script; this file is the source of truth for the manifest, and tests pin that it must pass the fleet-section pre-validation.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Content Pipeline", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install tkHe8IHE0BuDYYIg5LglUw

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- topic-pitch-card — 选题策划提交立项候选的标准格式：一句话、读者、角度、形态、交稿日。
- writing-standards — 撰稿人的成稿纪律：钩子、段落结构、引用标注、完成度申报。
- review-checklist — 审校岗的退稿/通过标准：事实、结构、用词三层核查，输出逐条理由。

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
