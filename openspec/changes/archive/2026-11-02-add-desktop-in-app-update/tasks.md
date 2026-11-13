# Tasks: add-desktop-in-app-update

## 1. 发布道

- [x] 1.1 静态道宿址落位——**RustFS 内网道**（用户 2026-11-02 提供：S3 兼容，100.64.0.10:9000，
  tailnet-only 零公网暴露）：桶 `yizuo-desktop` 已建+匿名读策略（GetObject）+v1.3.19 三件套
  （exe/dmg×2+electron-builder 自产 latest*.yml）上传，**yml sha512 与实物比对一致**，匿名 GET
  206 全通；坑=mc 上游 410（MinIO 撤档）→curl --aws-sigv4 零安装直干；yml url 是破折号消毒名、
  原始件带空格——按 yml 名补传才是客户端视角。CI 上传自动化**已收口**：OCI 中继道（wire-downloads 先例）——release 班把安装器+latest*.yml
  打为 hkccr yizuo/desktop-releases:current（runner 够得着注册表）→ cheap-3 desktop-lane-sync.sh
  （cron */10，已部署实测）拉取→sha512 校验→curl sigv4 推 RustFS；test tag 全链演练 SYNCED 眼见
  +残留即清；坑录三条=curl 7.88 缺 x-amz-content-sha256 显式补/docker create 无 CMD 失败
  （--entrypoint /）/openssl base64 折行（校验器折行合并）
- [x] 1.2 CI 发布班：release.yml 增「生成 latest*.yml」（gen-desktop-latest-yml.mjs，sha512/size
  原子写）+ 随 GitHub Release 与 MinIO 道上传；哈希一致性测试在 3.1

## 2. 客户端接线

- [x] 2.1 electron-updater 依赖 + 主进程生命周期（延迟查新/后台下载/退出安装）+ 三态事件面
  ——**坑录**：electron-updater 是 CJS 且导出经 TS `__exportStar`/getter 动态挂载，ESM 具名导入
  (`import { autoUpdater } from "electron-updater"`) 链接期 SyntaxError 杀死打包 app 整个 import 图
  （五轮 E2E 全暗真凶：state 文件永不现+stdout 空，叠加打包态 console 镜像到 userData/main.log）；
  正解=默认导入+解构，静态守卫测试钉死（3.1）
- [x] 2.2 设置面：检查更新入口 + available/downloaded/error 状态可见 + macOS 降级原因标注
- [x] 2.3 通道 URL 可配（默认道内置，桌面管家 config 面读取）

## 3. 测试

- [x] 3.1 单测 7/7（scripts/test-desktop-update.mjs）：生成↔解析回环（electron-updater yml 形状）/
  版本三方比较（1.3.9<1.3.10+prerelease 语义）/平台门（win 真升级·未签名 mac 降级·签名可翻）/
  mac 通知检查（新版本 dmg URL·通道不可达 null 静默·无通道不猜）/生成器垃圾入即抛/
  **ESM 导入守卫**（updater.js 必须默认导入 electron-updater，禁具名——2.1 坑录的回归钉）
- [x] 3.2 真机（GitHub 托管 runner 双平台，desktop-update-e2e run 41369053525 全绿）：
  Windows 端到端=Phase1 `module-loaded→up-to-date`、Phase2 道改 99.0.0（同件同哈希）→
  `downloaded`（electron-updater sha512 真校验过，final state 钉 version=99.0.0）；
  macOS 未签名=Phase1 同绿、Phase2 `notify-only`+dmg URL 浮出（宁提示不假绿实证）；
  打包树断言 electron-updater 可解析两面绿。烟测道（win-install-smoke）跑已发布 tag，
  本改动随下一个 release tag 自然入道（app 全程存活由 E2E 进程哨兵旁证，backend 未被打死）

## 4. 收尾

- [ ] 4.1 主 spec desktop-app-update 建立（归档时）+ 台账续记 + 双分支收正
