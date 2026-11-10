# 永忆官网静态文件换版工单（2026-10-29 · 合规整改）

> 交付对象：雷池（SafeLine）机器上的运维 AI。
> 本文档自足，可整体粘贴给执行侧，无需其他上下文。
> **状态：已执行完毕（2026-10-29，雷池侧）**——公网验证全绿，响应体哈希与工单逐位一致；
> 本文 §三 已按实测改为 codeload 主通道（raw 直拉在雷池机与 cheap1 均被 SSL 重置）。执行细节见文末「六、执行记录」。

## 一、背景与现状（一句话）

永忆官网（`yongyi.finddatatech.cloud`）公开内容做过一次合规清洗：旧版首页把内部节点名与部署变更史写进了演示区块，GitHub 公开仓与历史已全部清洗并强推；**你侧静态目录里现在还是清洗前的旧版文件，需要按本单换成新版**。清洗只动了两个文件的内容文案，页面结构、样式、依赖关系一概未变。

## 二、不要动的部分（保持现状）

以下全部**保持原样、不做任何变更**：

- 两个域名的 DNS、TLS、雷池 site 条目；
- `memory.finddatatech.cloud` 的 API 反代与路径门（`/healthz` 放行、`/digest` 放行、`/mcp` 放行且关缓冲、`/admin/*` 与 `/capture` 边缘 404）；
- `memory.finddatatech.cloud` 根路径落地页文件（**本次未改**，现值 sha256 前 16 位 `79e399d6ab893a28`，可用于自证没动它）；
- Caddy 各站点块结构、`file_server` 指向、`Cache-Control` 策略（`index.html` no-cache、css/js 可 7 天）；
- `style.css`（**本次未改**，现值 sha256 前 16 位 `6ea63c59c5f36400`）。

## 三、要换的两件文件（官网静态目录内，同名原位替换）

### 拉取通道（按实测可用性排序）

`raw.githubusercontent.com` 在本机与 cheap1 均不可达（SSL 连接被重置），默认走整包通道：

```bash
# 主通道：codeload 整仓 tar.gz（同一 master 世代，site/ 下取同名文件即可）
curl -sfL https://codeload.github.com/FindDataTechnology/fd-memory/tar.gz/refs/heads/master -o fdm.tgz
mkdir -p /tmp/fdm && tar xzf fdm.tgz -C /tmp/fdm
# 目标文件 = /tmp/fdm/*/site/index.html 与 /tmp/fdm/*/site/script.js
```

备用通道（若哪天 raw 可达）：

```
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/index.html
https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/script.js
```

目标文件与校验值（**拉到后先逐位核对 sha256 前 16 位，对得上才落盘**）：

```
site/index.html   # sha256 前16位: fff0dfb53400ef29
site/script.js    # sha256 前16位: c23f06542e79c787
```

示例命令（主通道整包形态）：

```bash
cd <官网静态目录>   # 即 Caddy file_server 当前放 index.html 的那个目录，就地替换
cp /tmp/fdm/*/site/index.html index.html.new
cp /tmp/fdm/*/site/script.js  script.js.new
sha256sum index.html.new script.js.new
# 期望输出以 fff0dfb53400ef29 与 c23f06542e79c787 开头；不符则中止并回报，不得落盘
mv -f index.html.new index.html && mv -f script.js.new script.js
```

落盘前后可顺手 diff 一下旧新文件：改动应**只是文案级**（演示区块措辞、页脚多一条「部署教程」链接），没有新增外部资源引用、没有目录关系变化（仍以相对路径引 `./style.css` `./script.js`）、无构建需求。若 diff 出现结构性差异或哈希校验不过，停下回报。

## 四、换后验证（全部满足即收工）

```bash
# 1) 旧演示内容必须已消失（本单核心判据）
curl -s https://yongyi.finddatatech.cloud/ | grep -c "cheap"            # 期望 0
# 2) 新内容在位
curl -s https://yongyi.finddatatech.cloud/ | grep -c "示例 evidence"     # 期望 >0
curl -s https://yongyi.finddatatech.cloud/ | grep -c "部署教程"          # 期望 >0（页脚新链接）
curl -s https://yongyi.finddatatech.cloud/script.js | grep -c "node-b"  # 期望 >0
# 3) 既有门面无回归
curl -s https://yongyi.finddatatech.cloud/ | grep -c "会话会结束"        # 期望 >0（真站标题）
curl -s https://yongyi.finddatatech.cloud/style.css | grep -c "070c17"  # 期望 >0（样式未动）
curl -s https://memory.finddatatech.cloud/healthz                        # 仍须 200
curl -s -o /dev/null -w '%{http_code}\n' https://memory.finddatatech.cloud/digest        # 仍须 401
curl -s -o /dev/null -w '%{http_code}\n' https://memory.finddatatech.cloud/admin/mint    # 仍须 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://memory.finddatatech.cloud/capture # 仍须 404
```

若公网读到旧内容，是边缘/CDN 缓存未过期，等待或用 `curl -sI` 看缓存头确认回源，不算失败。

## 五、异常回报口径

- 哈希对不上 / diff 有结构性变化 / 拉不到（raw 与 codeload 均不可达）：**不要落盘**，记录现象回报属主（属主本机有同一世代的资产文件可直供）。
- 验证第 1 项 grep cheap 不为 0：确认落盘目录正确、浏览器/CDN 缓存已过期，仍不为 0 则回报。

## 六、执行记录（2026-10-29，雷池侧完成 · 属主侧独立复核通过）

- **通道**：raw.githubusercontent.com 在雷池机与 cheap1 均被 SSL 重置，改走 codeload 整包取 `site/` 同名文件，sha256 逐位核对一致后落盘。
- **换版前双锁**：index.html `fff0dfb53400ef29` ✅、script.js `c23f06542e79c787` ✅；
  style.css `6ea63c59c5f36400` 与 memory-landing `79e399d6ab893a28` 确认未动。
  diff 纯文案级（index 7/249 行：figcaption 改「示例 evidence·虚构」+节点名 ×3 改 node-a/b+页脚新增部署教程链接；script 2/205 行），无新增脚本/字体/图片、相对路径关系原样。
- **落盘**：`.new` 暂存 → 服务端二次校验 sha256 → `mv -f` 原位替换；旧版留档 `*.bak-precompliance-20261029`。
- **第四节清单公网实测全绿**：cheap=0；示例 evidence/部署教程/「会话会结束」/style `070c17`/js `node-b` 均在位；
  healthz 200、digest 401、admin/mint 404、capture 404。另加自证：公网响应体 sha256 与文件逐位一致，边缘无旧缓存。
  属主侧 2026-10-29 独立复核同样全绿。
- **保持原样项**：DNS、TLS、雷池 site 条目与 WAF 白名单、memory 域反代与路径门、落地页文件、Caddy 块结构、
  缓存策略（`/` 与 index.html no-cache、css/js max-age=604800）全部未动。
- **通道教训固化**：后续本域补给单默认 codeload 整包，raw 降为备用（已回写 §三 与部署需求书 §九）。
