# statute-validity-check

## What this is

法条检索与效力核查。当用户要查某法条原文、核对某条文是否现行有效、确认条号是否因修订变动、查某法律问题的法律依据（"能不能""是否有效""如何认定""依据哪一条"）时使用。语义召回候选条文后逐条锚定效力状态，输出带效力状态与 provenance 的法条清单；非"有效"版本明确标注不得作现行法。

Statute retrieval and validity verification. Use when the user wants the original text of a statute, to check whether a provision is currently in force, to confirm whether article numbers changed in a revision, or to find the legal basis for a legal question ('is it allowed', 'is it valid', 'how is it determined', 'which article applies'). After semantically recalling candidate provisions, each is anchored to its validity status; outputs a statute list with validity status and provenance; versions not 'in force' are explicitly marked as not to be used as current law.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.

## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
