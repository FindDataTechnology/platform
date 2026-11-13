# Proposal: dependency-security-round

## Why

Dependabot 在 `FindDataTechnology/fd-craw-private` 上累计 **151 条 open 告警**（root 93 / miniapp 40 / web 9 / app 4 / dsh-matrix 3 / facet/web 2），其中 **5 条 critical** 跨两份 manifest：root 的 `proxy-addr <2.0.8`、`tar <=7.5.18`（canvas→node-pre-gyp 链上的 tar@6.2.1），miniapp 的 `swiper <12.1.2`、`shell-quote <1.11.0`、`decompress <=4.2.1`。前三刀（knowledge 对账 / chat 二刀 / 桌面补版）按「依赖升级不混车」纪律全部推迟依赖项，现在三刀已归档、v1.3.18 已出片，是独立一车清 critical 并把「修 / 豁免」判据建制化的窗口。

## What Changes

- **root `package-lock.json`**：`npm audit fix`（非 force）——清 proxy-addr 2.0.8（critical）+ 一批范围内高危：undici 7.30/6.29（双实例）、express 4.22.3 / body-parser 1.20.8 / qs 6.16 / multer 2.4 / compression 1.8.2、`@modelcontextprotocol/sdk` 1.32.1、hono 4.13.13、fast-uri、`@xmldom/xmldom`、electron 43.8.3、electron-builder 族 26.18.0 等；顺带清除 extraneous 的 `tencentcloud-sdk-nodejs-{asr,tts}`（10-18 语音实验残留，源码零引用）。
- **root `package.json` 新增 overrides**：`@mapbox/node-pre-gyp` → `tar ^7.5.22`——dependabot 那条 tar critical 告的是 tar@6.2.1，`npm audit fix` 不动它（npm 只修两个 7.5.20 实例）；scoped override 是唯一能清掉它的路径（兼容性论证见 design D2）。
- **miniapp**：`npm audit fix`（shell-quote 1.11.0 / launch-editor 2.14.2 / webpack-dev-server 族 / postcss / adm-zip 等，全 dev 链）+ overrides `swiper → 12.1.2`（`@tarojs/components@4.2.1` 与最新 4.3.0 **都精确钉 11.1.15**，上游无修，普通升级永远动不了它）；decompress 豁免记录（dev-only、无补丁、仅 `taro init` 模板下载路径可达）。
- **web**：`npm audit fix`（vite 6.4.4 / react-router·react-router-dom ≥7.18.2 / nanoid / postcss / source-map-js）。
- **facet/web**：`npm audit fix`（vite 6.4.4，dev-only）。
- **dsh-matrix**：闭包内在范围传递修复（`@modelcontextprotocol/client` ≥2.3.0、fflate 0.8.3），**不动 dsh rc.2 精确钉**；若范围不容则豁免。
- **豁免 / 推迟清单**（轮次记录 `notes/round-record.md`）：`@deepseek-ai/dsh*` 高危（rc.2 锁定决策，2026-10-19 已否决 0.2.1 final）、officeparser 8 / pdfjs-dist 8 大版本、`@llamaindex/readers` 上游无修、`app/package-lock.json` 全部（归在途 change add-mobile-app）、braces / node-forge / html-minifier / git-clone / csv-parse 等无补丁项。
- **本轮不出片**：修复随下一班发布列车（服务端镜像 + 桌面 v1.3.19+）上产；FDT 私有额度已尽（2011/2000），全部测试门本地跑。

## Capabilities

### New Capabilities

- `dependency-security`: 依赖安全告警的处置契约——critical/high 在归属 manifest 内修复或带可达性论证的书面豁免；传递大版本跳变（nested major）与未声明包清扫是显式审查项；每轮以可复验测试门收口。

### Modified Capabilities

（无）

## Impact

- 6 份 lockfile 动 5 份（app/ 不动）；`package.json` 与 `miniapp/package.json` 各新增 overrides 段。
- 运行时面（随下一班列车生效）：prod cell 镜像（express 中间件族 / MCP SDK / hono）、桌面应用（electron 43.8 / electron-builder 26.18 / dsh-matrix 闭包）、MP（weapp 包经字节级比对证明零变化）。
- 测试门：`lint` + `test:unit`（含 dsh 合同）+ web `typecheck`/`build` + e2e fast + miniapp `typecheck`/`build:weapp` + facet/web build + `install-dsh-matrix`。
- 打包缓键：`package.json` 变更使 resources 缓存 key 变化，下一班 tag 会重建 bundled Node（一次性 +几分钟）。
