# pack-install-server-side-manifest — 设计

## 上下文

- 故障定位（2026-10-06，浏览器点检）：SafeLine（platform.finddatatech.cloud 前置）对 POST body 的注入规则拦截——换测（同字节改必失败字段仍重置）、假内容大 body 通过、2KB 分块（chunk 5/18 → 403）+ 前缀二分（触发点：SQLi 样例 `WHERE name='<name>'` 与 Python 片段邻域）三步锁定为内容触发；`<script`/`UNION SELECT`/`subprocess.run`/`curl|sh` → 403。合法 SKILL.md 正文不可改写，故改传输设计。
- 既有资产：平台已有市场代理（`/api/packs*` → facet，`FACET_INTERNAL_TOKEN` + `x-facet-user` 转发身份）——服务端取包复用它，不新增通道。
- 设计源 D8（manifest 经浏览器下发、cell 侧二次校验）在当时假设「浏览器是 manifest 的搬运工」以省一次服务端往返；边缘 WAF 证明该假设不成立。

## 决策

1. **服务端取包复用市场代理函数**：安装路由调用与读市场同一套内部请求（facet 基址 + 内部令牌 + 调用者身份头），保持私有包 owner-scoped 语义与 404 行为一致；不引入第二套鉴权。
2. **兼容窗口双收**：`{packId, version}` 与 `{packId, version, manifest}` 双形态并存，后者走同样的重校验（防滚动期旧 web 打新 server 出 400）；web 客户端改为只送短表单（该短表单无敏感模式，天然过 WAF）。
3. **拒绝备选**：(a) SafeLine 放行该路由——治标、留规则维护债，用户拍板选根治；(b) 改写 skill 正文规避 WAF 模式——侵蚀用户内容、不可接受；(c) 前端 encode 后传输——绕过安全层语义、更不可取。
4. **失败语义**：取包失败（facet 5xx/404/超时）→ 明确错误、零写入；不降级为「用客户端 manifest」（两者同时存在时服务端取值优先，客户端值仅在后端取不到且显式兼容分支时才用——实现时以「有 manifest 便用、否则服务端取」的最简语义为准，避免双源歧义）。

## v1.x / 不做

- WAF 规则层任何改动；
- `uninstall-preview`/升级路径不动（不涉及大 body 传输）。

## 风险

- facet 不可达时安装不可用（此前浏览器直送可绕开）——可用性与市场浏览同生共死，语义更一致，接受；
- 三清单漏滚 = 假上线（既有教训），发布节显式包含 platform/platform-demo/facet。