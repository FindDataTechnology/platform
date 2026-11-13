# legal-doc-pre-release-review

## What this is

在法律业务 Skill 生成正文或要素式字段后、法律文书模板与导出生成本地 Word 前触发。用于审查 draft.html/preflight-meta.json 或 complaint-data.json/fill-plan.json、读取复查摘要、法规校验摘要、来源边界和用户确认记录，决定是否可以进入正式 DOCX 导出；发现问题后必须闭环推进到业务 Skill 整改、用户确认或材料读取流程。

Triggered after a legal business skill generates the body text or element-based fields and before legal document templates are exported to a local Word file. Used to review draft.html/preflight-meta.json or complaint-data.json/fill-plan.json, the file-read re-check summary, the statute verification summary, source boundaries, and user confirmation records, and to decide whether formal DOCX export may proceed; when issues are found, closure must be driven through business-skill remediation, user confirmation, or the material re-reading flow.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/pa1nrui1/legal-skills


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
