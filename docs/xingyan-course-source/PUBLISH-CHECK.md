# 个人代理课程 · 上线核验（2026-11-10）

> 课程：`yizuo-mandate-disclosure`（中文《让智能体替你判断：委托状的三个旋钮》／
> 英文《Let the agent decide for you: the three dials of a mandate》）。
> 本文是**核验记录**，不是发布步骤。

## 一、结论

| 语言 | URL | HTTP | 标题 | 正文关键词 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 中文 | `/zh/research/academy/yizuo-mandate-disclosure/` | 200 | 让智能体替你判断：委托状的三个旋钮 | **18 处命中** | ✅ **真的在线** |
| 英文 | `/en/research/academy/yizuo-mandate-disclosure/` | 200 | The platform for your always-on agent clusters（站点首页标题） | **0 处命中** | ❌ **回退壳，等于没上线** |

## 二、判据为什么不能只看状态码

英文页返回 **200**，但它是回退壳——返回的是站点首页 title，学院里没有本课内容。
这正是本仓已经记过一次的故障形态（`docs/xingyan/baiye/publish-log.md:34`
「实测 /zh/research/academy/ 深链为回退壳：返回首页 title，学院内无本课程内容」）。

**能自证的判据是这两条，缺一不可：**

```bash
# 1) 标题必须等于课程标题，不能是站点首页标题
curl -sS '<url>' | grep -oE '<title>[^<]*</title>'

# 2) 正文关键词必须命中（选课程里独有的词，别用站点通用词）
curl -sS '<url>' | grep -c '委托状\|披露范围\|只给建议'      # 中文
curl -sS '<url>' | grep -c 'decision mode\|disclose scope'   # 英文
```

中文页实测：title 正确 + 18 命中；英文页实测：title 是首页标题 + 0 命中。

## 三、别拿白夜那几门课当对照

`baiye-ai-foundations`、`baiye-fleet-build` 在本站 `/zh/` 与 `/en/` 下**同样返回首页
标题**——它们的主站是 `baiye.finddatatech.cloud`（见 publish-log 第 5、9.1 行），
本站只是入口卡。所以它们回退壳是预期，不能用来判断「本站路由坏了」。

**唯一有效对照是同一门课的两种语言**：zh 正常 / en 壳 → 问题在 en 这一版没有进 CMS，
不在路由。

## 四、为什么没有当场修

- 源文件是齐的：`docs/xingyan/academy/en/yizuo-mandate-disclosure.md`（完整译文）、
  `zh/` 同名文件、`media/yizuo-mandate-disclosure/` 五张图；
- 重发需要 CMS 凭据：`scripts/publish_course.py` 读 `XINGYAN_ADMIN_PW`
  （`XINGYAN_CMS` 默认 `https://cms.finddatatech.cloud`）。**当前环境没有该变量**，
  匿名读 `/api/courses?slug=...` 返回 403。
- 所以英文版重发需要你提供密码，或由持有凭据的会话执行：

```bash
export XINGYAN_ADMIN_PW='...'
python3 docs/xingyan/scripts/publish_course.py yizuo-mandate-disclosure \
  --doc docs/xingyan/academy/en/yizuo-mandate-disclosure.md --locales en
```

- 重发已知的三个坑（上一轮踩过，脚本已修）：行内 YAML 列表要转数组、
  claims/sources 不要二次 JSON 序列化、en PUT 必须带非本地化字段
  （`slug`/`order`/`level`，缺一个就会 200 但内容不更新）。

## 五、复验命令（重发之后再跑一次）

```bash
u='https://www.finddatatech.cloud/en/research/academy/yizuo-mandate-disclosure/'
curl -sS "$u" | grep -oE '<title>[^<]*</title>'      # 期望：Let the agent decide for you…
curl -sS "$u" | grep -c 'decision mode\|disclose scope'   # 期望：> 0
```

两条都过才算上线。只看 200 会得到假绿灯——这次就是这么差点漏掉的。

## 六、追到源头：内容不在任何一个 git 分支里

为了绕开 CMS 凭据，我试着从站点仓直接补 en 那个文件。结果这条路的每一段都排除了：

| 检查 | 结果 |
| --- | --- |
| 站点技术栈 | `<meta name="generator" content="Astro v7.2.0">` —— 静态生成 |
| `academy` 集合的 loader | `glob('./src/content/academy/**/*.md')` —— 纯仓内 Markdown，无运行时拉取 |
| `src/content/academy/{zh,en}` 文件数 | 各 11 个，**双方都没有 `yizuo-mandate-disclosure.md`** |
| `origin/main` 与全部 20 个远端分支 | **都没有**这个文件（逐个 `git ls-tree` 查过） |
| 同级 web 仓（`fd-marketing-web` 等） | 也没有 |
| 两个 URL 的响应头 | 同一个 `nginx/1.24.0 (Ubuntu)`，同一套静态产物 |

也就是说：**线上 zh 课页存在，但它的源文件不在任何仓库里。**

唯一的解释是仓里那条提交写的事情已经发生了 ——
`3bec6bc fix(content-sync): 序列化器补齐 claim 骨架与来源 id，并以 CMS 为真源对齐内容快照`：

```
CMS（真源） → content-sync 序列化 → src/content/academy/*.md（构建期快照，不入库）
            → Astro build → nginx 静态托管
```

所以「补 en 版」不能靠提交 Markdown —— 那份快照不是仓库的一部分。**唯一入口是 CMS。**

## 七、结论（第二次独立确认）

要修英文版，只有一条路：**写入 CMS**。

```bash
export XINGYAN_ADMIN_PW='...'
python3 docs/xingyan/scripts/publish_course.py yizuo-mandate-disclosure \
  --doc docs/xingyan/academy/en/yizuo-mandate-disclosure.md --locales en
```

然后等 content-sync + 构建 + 部署跑完，再用本文件 §五 的两条判据复验。

在此之前，英文链接 **200 但内容为空**，对外不要贴；中文链接可以贴。
