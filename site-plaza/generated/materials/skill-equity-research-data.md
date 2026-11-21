# equity-research-data

## What this is

个股投研的取数与口径纪律层。当用户要求为某家 A 股/港股公司取财务科目、公告披露、行业财务指标或公司面板变量，或需要交代某个数字的来源工具、数据期数、币种与单位时使用。财务与披露一律走柏讯服务端通道 A，价格与市值一律走本地 DAAS 通道 B，两条通道不混用、不互相替代；取不到的数值如实声明缺口，不得填补。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/equity-research-data


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
