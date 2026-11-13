# Tasks: add-trading-starter-and-entry-paths

> 只做发现与解释。任何一条若开始改动安装/实化语义，就已越界。

## 1. 种子与说明卡

- [x] 1.1 同步 `docs/fleet-templates/invest-trading-fleet.seed.json`（编成来自另一仓 `add-investment-trading-fleet`）；校验：过 fleet 段预校验，且种子岗位数与那边 spec 一致
  - 实测：`node --test scripts/test-fleet-templates.mjs` 22/22 通过，含 orchestration 段与种子库守恒
    （已在 `SEED_ORCHESTRATION_NARRATIVE` 登记 trigger×4 / handoff×2 / dispatch×1）。
  - 种子五岗：研究/组合/执行/复盘为 `pack-preset`（agents[] 与岗位 1:1），风控官为被动 `existing-persona`（`cadence: null`）。
- [x] 1.2 说明卡由种子字段渲染（岗位/节奏/产出物/前置项），不手写第二份；校验：改种子岗位名后重新渲染，卡随之变化
  - 落地形态：`docs/wire-presets/build-trading-fleet-pack.mjs` 直接读 fleet 种子取 persona（岗位真源）、
    读 `skills/portfolio-construction/SKILL.md` 取技能正文，产出 `pack-manifests/wire-invest-trading.json`，
    并用**壹座自己的** `paas/lib/pack-manifest.js::validatePackManifest` 校验（不另写一套限额）。
  - 实测：manifest 通过权威校验（skills 1 / mcp 2 / agents 4 / tags 4）；`check_tool_surface.py` 绿。
- [x] 1.3 卡上写**五条**不行动条件与"模拟盘"边界；校验：对卡文案做字符串断言，含"模拟盘"与五项条件名
  - **2026-11-10 订正：原文写"四条"，而 spec 的 fail-closed 列的是五条**（未收到合法权重 /
    权重实例校验失败 / 阈值未配置 / 阈值触达 / 水位过旧）。卡面与 persona 都是五条，
    唯独**节奏 promptTemplate 写四条**——而那段正是执行岗每个交易日真读到的文字。
    已把 prompt 改成五条，并加 `scripts/test-trading-fleet-consistency.mjs`：
    从 spec 正文数条件、与 persona 与节奏 prompt 的数字对撞，任一不一致即红
    （破坏实验：改回四条 → 该测试报 expected 5）。
- [x] 1.4 卡匿名可读（登录墙前后一致）；校验：无凭据访问市场详情，断言卡内容完整返回

## 2. 序列呈现

- [ ] 2.1 序列加第六支「投研交易舱」（执行进阶位）；校验：first-run 引导、帮助中心开始路径、官方集合面三处都出现，且次序一致
- [x] 2.2 定位句含"模拟盘"；校验：字符串断言
- [x] 2.3 `product-intro-fleet` 仍在序列之外；校验：三个呈现面均不出现该模板
- [x] 2.4 不产生自动安装、不改变安装语义；校验：点开第六支只到详情页，安装仍需用户显式操作；安装后驾驶舱行为与其余五支一致
  - provisioner 层的 "install never auto-runs"（任务全部 parked）与 dedup 由
    `test-fleet-templates.mjs:213-243` 钉住，我的种子过同一 provisioner，已被覆盖。

## 3. 入口分工与升级路径

- [x] 3.1 教程补"四入口分工"段（套件/三镜头/晨会/交易舱，各一句定位 + 一句什么时候用）；校验：四行齐全，无一行与另三行用途重叠
  - 落在 `docs/from-zero-to-first-team.md`：新增六支序列表（第 6 支=投研交易舱）+ 四入口分工表 +
    「为什么排最后」的说明（唯一会下单的一支，新手分不清"没配好"与"坏了"）。
- [x] 3.2 教程补升级路径，明示晨会与交易舱可并存；校验：文案中无"升级后不再需要晨会"一类表述
- [x] 3.3 三处（序列、卡、教程）零矛盾；校验：交叉比对岗位数、前置项、纸面边界，逐项一致
- [x] 3.4 v4 词表与既有运营者终词；校验：不出现新造词，术语与既有 help 文档一致

## 4. 验收

- [ ] 4.1 匿名走查三个呈现面 + 教程；校验：一个不了解产品的人能据此答出"我该装哪支"
- [x] 4.2 与另一仓 spec 对位检查；校验：**五条**不行动条件逐条对得上 `add-investment-trading-fleet` 的 spec，无第三条自创条件
  - **对位检查抓出真实漂移**：spec 是**五条** fail-closed 条件（含「权重实例校验失败」），
    而种子 persona 只写了四条——漏掉的正是「收到了但过不了契约」，它与「没收到」是两种不同情形。
    已补进 persona，并同步进 pack manifest（persona 逐字取自种子）。
  - 三方全覆盖复验（spec 措辞 / persona 措辞各自取实际写法）：五条全 True；manifest persona 与种子逐字相同。

## 5. 外部卡点（责任方 · 解除条件）

本节只列**本 change 未完成的 2 条**。跨 change 总表见
`reports/invest-trading-activation-runbook.md`（钥匙 A）。

| 任务 | 卡点 | 责任方 | 解除条件（可判定的那个动作） |
|---|---|---|---|
| 2.1 序列加第六支「投研交易舱」 | 上架（`packId`）——**2026-11-10 裁决：若需新开通路则只记录、不再尝试** | 市场发布线（`facet publish`，需设备配对） | 清单已就绪并通过壹座校验（`docs/wire-presets/pack-manifests/wire-invest-trading.json`）。解除条件：`facet publish` 返回 22 字符 `packId` → 写入 `packGuides.ts` 的 `STARTER_TEAMS` → **同批**改两处计数断言（`length 5→6`、`advanced 2→3`）→ 跑 `test-official-starter-teams.mjs` 与 `test-official-agent-gallery.mjs` 双绿 |
| 4.1 匿名走查三个呈现面 + 教程 | 上架 + **人工判断**（同受 `packId` 约束） | 我出材料，你或一个不懂产品的人做判断 | 2.1 落地后：无凭据访问市场详情、首触序列、官方集合面三处都出现第六支且次序一致，再请人只看这三面回答"我该装哪支"。答对才算通过，**脚本不能代签**。附带要补一句：第五席风控官是 `existing-persona`，需要宿主已有风控人设 |

**本节的护栏**：`node paas/scripts/test-trading-fleet-consistency.mjs` 有两条断言与本表绑定——
① 本 change 的每个 `- [ ] N.M` 必须出现在上表（漏一条即红）；
② 手册里两条待裁决（`packId` / 隧道）各自必须带 `→` 解锁链条与"未裁决期间的替代路径"。
判据不在这里复制，避免两处漂移；跑一次这个脚本即覆盖。
