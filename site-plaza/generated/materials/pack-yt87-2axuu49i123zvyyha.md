# Wire Ontology Builder / 柏讯本体建设团队

## What this is

柏讯数据本体建设团队：对靶客户数据面持续盘账、建模、校验、经动作闸提议落库，让实体关系图谱有真实内容。五岗流水线：盘账员（只读画像：行列规模、候选主键、疑似外键）→建模师（实体/关系声明草案，业务名从列名直译禁臆造）→纪律校验闸（确定性规则放行或拦截，给列名级原因）→声明提案员（经 wire_action_propose 提议内置声明动作，即时返回即合规，写操作永不直调）→台账主编（三点实调抽样对账，缺位如实标注）。全链只读+提案制：本体声明经客户动作闸确认后落库，数据行零写回，实体与关系只建不改不删。

A Wire ontology-building cluster for the data plane: profile datasets, draft entity/relation declarations, pass deterministic validation, and file declarations through the customer action gate so the entity graph holds real content. Five-role pipeline (profiler → modeler → deterministic gate → proposal clerk → ledger editor) with read-only discipline, zero data-row writes, create-only v0.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire Ontology Builder", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install YT87-2Axuu49I123zVYyhA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- ontology-readonly-profiling — 只读取证流程：数据集清单→表结构→逐列四证据（唯一性/空值率/值域样本/外键候选）。
- ontology-draft-deterministic-rules — 草案自洽五判据：主键⊆列快照、关系目标∈主键集合、四元组唯一、1:n 与 n:1 互斥、中间集值域。
- ontology-action-proposal-protocol — 声明提案协议：一件一单、全文件正文、不重试刷屏、未在册动作走 escalate。

MCP server references (1): wire-ops

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
