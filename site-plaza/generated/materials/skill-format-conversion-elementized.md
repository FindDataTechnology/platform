# format-conversion-elementized

## What this is

要素式格式转换。当用户上传或粘贴一份传统式法律文书（起诉状、答辩状等），希望转换为法院推广的要素式示范文本格式时使用。识别案由并匹配最高院示范文本，逐要素从原文提取填充，逐要素标注来源（取自原文/原文缺失/需补充），原文事实保真不改写；案由无法识别或示范文本未收录时如实说明，不以自拟模板冒充示范文本。

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.

## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
