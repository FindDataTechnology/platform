# 音色目录配置（改音色不出片）

**一句话**：有哪些音色可选，写在 `server/voice-catalog.json` 里，随镜像发布；
部署可以用一份整目录挂载覆盖它，**改完下一次读取生效**——不出镜像、不重启 pod。

判据：`node scripts/check-voice-config-migration.mjs` 打印当前 `voice` 块、目录来源、
以及下一保存会不会被拒。

---

## 目录是什么、不是什么

| 是 | 不是 |
|---|---|
| 「这个部署有哪些音色**可选**」——部署事实 | 「这个部署**选了**哪一个」——那是 `voice` 配置块，存库、管理员写 |
| 随镜像发布的一份文件 | 数据库表 |
| 可被整目录挂载覆盖 | 每个部署各存一份、彼此漂移 |

职责分离的理由和 `im-lanes` 一样：目录是**事实**，随产物走；配置块是**选择**，随部署走。
两者混在一处就会出现「仓库里一份、库里一份，两份漂移」。

## 条目形状

```json
{ "protocol": "tencent", "model": "tencent-tts", "voice": "101001", "label": "智瑜（情感女）" }
```

- `protocol` 是封闭集合（`tencent` 整数 VoiceType / `doubao` 字符串音色），新协议要改代码，不改数据。
- `model` 与 `voice` **成对**，二者不可拆。拆开喂给上游必然被静默换回默认音——这正是本目录要消灭的失败形态。
- `label` 只用于界面显示，不参与校验。

## 两层，各有各的职责

| 层 | 位置 | 谁改 | 生效方式 |
|---|---|---|---|
| 随包默认值 | `server/voice-catalog.json`（打进镜像） | 开发者 | 出片 |
| 运行时覆盖 | ConfigMap → `/etc/voice-catalog/voice-catalog.json`（整目录挂载） | 运维 | **下一次读取** |

覆盖目录由 `VOICE_CATALOG_DIR` 指定（缺省 `/etc/voice-catalog`）。整目录挂载，不用 subPath——
理由与 `docs/im-lane-configuration.md` 的同一节逐字相同（subPath 挂载不热更）。

## 加一个音色之前

**必须过试听**：`POST /api/voice/catalog/preview {model, voice}`（管理员）。
上游对**已下线**的音色同样回 200 + 默认音，只有真人听一句才能识破。
目录里录一个已下线的音色，试听就会露馅——这是唯一诚实的判据。

目录里默认位是 `tencent/tencent-tts/101001 智瑜`，依据是
`docs/handoff/vaas-voice-optimization-2026-10-27.md` 的实测推荐；
豆包那条文档写的是「先补听再决定」，所以未验过的先不进默认位。

## 房间侧的「部署默认」是哪一份（一个真实边界）

设置页（Models → 语音）保存的音色**存进 cell 的库**；但房间活在 gateway 进程里，
gateway 读不到 cell 的库。gateway 只读 `VOICE_CONFIG` 环境变量，而生产清单没有这个变量。

所以**房间播报的「部署默认」落到目录的 default 条目（`tencent/tencent-tts/101001`）**，
不是设置页里存的那个音色。要让房间默认跟随设置页，得把 `voice` 块经 `VOICE_CONFIG`
下发、或开一条 gateway→cell 的读面——本期不做（见 design.md D4 与 Open Questions）。
逐岗/逐席音色不受此影响，它们各自显式声明。

## 三层回落

房间播报的音色按 **座席 > 岗位 > 部署默认** 解析（openspec: `add-room-voice-and-catalog` /
`zhiyu-room`）。任一层声明的音色若不在当前目录里（目录随上游变，旧声明必然过期），
该层被**跳过并留可读原因**，播报照常完成——绝不因为一条过期声明让播报失败。

## 迁移既有部署

把 `voice` 配置块的 `ttsModel`/`ttsVoice` 从自由文本改成目录条目后，写面会拒绝单边值或目录外值。
读面是宽松的（旧值按上游默认继续跑，不会中断），但管理员下一次保存会被拒。先跑：

```bash
node scripts/check-voice-config-migration.mjs
```

单边或目录外的值会被点名，并给出最接近的目录条目与建议写入值。
