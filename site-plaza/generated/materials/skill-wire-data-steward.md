# wire-data-steward

## What this is

柏讯数据治理。当用户要读表单收上来的数据、改错一条记录、撤销一次改错、查改错历史或导出 CSV 时使用。写修正必须带来源标记（source），不得代填；撤销只置回滚标记、原始行永不改写；导出结果带 truncated 字段，true 表示被上游行数闸截断而非全量——必须如实转述。任何工具失败原样转述，禁止以空列表冒充无数据。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/wire-data-steward


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
