# shock-detection

## What this is

柏讯信息冲击 · 冲击识别。当用户要求"最近有什么新公告/新信息""把今天的信息流筛一遍""找出可能构成信息冲击的条目"时使用。先查来源健康度，再按游标拉信息流（list_since），按来源三型（公告/部委/互动）与七组冲击类型做初筛，逐条附 item_id、发布时间、正文状态与初筛依据。只做识别与初筛：不读正文下结论（交 shock-reading）、不做窗口统计（交 shock-window）、不预测影响。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://gitee.com/FindDataTechnology/finddata-skills/tree/master/wire-presets/tree/main/skills/shock-detection


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
