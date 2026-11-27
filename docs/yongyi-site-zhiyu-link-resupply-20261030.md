# 永忆站换版单：加智语回链（单文件替换）

> 交给：雷池（SafeLine）机器上的运维 AI。
> 日期：2026-10-30。姊妹单：`zhiyu-site-deploy-requirements.md`（智语站本体）。
> **只有一个文件要换**，不动 CSS/JS、不动 Caddy、不动雷池站点配置。

---

## 一、为什么换

智语官网（`zhiyu.finddatatech.cloud`）已上线并通过验收。现在补**反向链接**，
让双站互链成立（智语站已经链到永忆，永忆站还缺回链）。

改动范围：`site/index.html` 里**只加了两个 `<a>` 标签**，其余内容与样式零改动。
- 导航：`组成 / 分层 / 召回 / 接替 / 起跑 / **智语** / GitHub`
- 页脚：`… · evidence report · **智语 · 团队如何交谈**`

---

## 二、新文件（唯一需要替换的）

| 项 | 值 |
|---|---|
| 文件名 | `index.html` |
| 体积 | **12,024 B** |
| sha256 | `c72d83702bbf8b46f6088b955f01485d35645b574f2f2afb67fd2f54b9be4495` |

**取件（公开仓，无需任何凭据）**：

```bash
# 首选：codeload 整包（雷池机实测 raw 可能被 SSL 重置，raw 只作备用）
curl -L -o /tmp/fdmem.tar.gz \
  "https://codeload.github.com/FindDataTechnology/fd-memory/tar.gz/master"
tar -xzf /tmp/fdmem.tar.gz -C /tmp
cp /tmp/fd-memory-master/site/index.html /tmp/index.html.new

# 备用（若 codeload 不通）
# curl -L -o /tmp/index.html.new \
#   "https://raw.githubusercontent.com/FindDataTechnology/fd-memory/master/site/index.html"
```

**取到后必须核对**：

```bash
sha256sum /tmp/index.html.new
# 期望：c72d83702bbf8b46f6088b955f01485d35645b574f2f2afb67fd2f54b9be4495
wc -c /tmp/index.html.new
# 期望：12024
```

**不要**用 tarball 里其它文件覆盖现有站点——`style.css` / `script.js` 本轮**没变**，保持现网原样。

---

## 三、替换

```bash
# 1) 备份（命名沿既有惯例）
cp /srv/yongyi-site/index.html /srv/yongyi-site/index.html.bak-pre-zhiyu-link-20261030

# 2) 覆盖
cp /tmp/index.html.new /srv/yongyi-site/index.html

# 3) 文件权限与属主跟现网一致（照抄原文件的，避免 403）
ls -l /srv/yongyi-site/index.html

# 4) 若站点由 Caddy file_server 提供，通常无需 reload（静态文件实时生效）；
#    若贵侧惯例是 reload，执行：
caddy reload --config /etc/caddy/Caddyfile
```

---

## 四、验收（四条，全过才算完成）

```bash
# 1 首页仍 200
curl -sS -o /dev/null -w '%{http_code}\n' https://yongyi.finddatatech.cloud/       # 期望 200

# 2 回链已生效
curl -s https://yongyi.finddatatech.cloud/ | grep -c 'zhiyu.finddatatech.cloud'    # 期望 2
curl -s https://yongyi.finddatatech.cloud/ | grep -c '团队如何交谈'                 # 期望 1

# 3 既有内容零回归（这几处必须还在）
curl -s https://yongyi.finddatatech.cloud/ | grep -c '会话会结束'                  # 期望 1
curl -s https://yongyi.finddatatech.cloud/ > /tmp/y.html
grep -c '永忆' /tmp/y.html                                                        # 期望 ≥5

# 4 回链目标可达（不同域，确认不是死链）
curl -sS -o /dev/null -w '%{http_code}\n' https://zhiyu.finddatatech.cloud/        # 期望 200
```

**人工 10 秒**：打开 `https://yongyi.finddatatech.cloud/`，导航应见「智语」一项、
页脚最右应见「智语 · 团队如何交谈」；点任一处应跳到智语站且能正常打开。

---

## 五、回滚

```bash
cp /srv/yongyi-site/index.html.bak-pre-zhiyu-link-20261030 /srv/yongyi-site/index.html
# 若执行过 reload 则再 reload 一次
```

回滚只影响这两个链接，不涉及任何其它文件或配置。

---

## 六、边界

- **只换 `index.html` 一个文件**；`style.css`、`script.js`、`memory-landing/index.html` 一律不动。
- 不改 Caddy 块、不改雷池 site 配置、不碰 DNS。
- 不要把仓库里其它文件（`docs/`、`.github/`）拷进静态目录。
- 若 `sha256sum` 对不上：**停止替换**，把实际哈希回传给我方，不要"先换上再说"。

---

## 七、回单

```
[状态] 完成 / 阻塞
[文件] 实际 sha256 + 字节数（是否与 §二 一致）
[替换] 备份文件名、是否 reload
[验收] §四 四条逐条贴实际输出
[人工] 导航/页脚是否眼见「智语」
```
