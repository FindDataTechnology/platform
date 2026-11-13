# 星研课程源备份 · yizuo-mandate-disclosure

> 为什么这里有一份副本：`~/finddata/docs/xingyan/` **不在任何 git 仓里**
> （finddata 根非仓库），而英文版在全网只有本地那一份——CMS 里没有、任何 web 仓的
> 任何分支都没有（2026-11-10 逐个 `git ls-tree` 查过）。这是防止唯一副本丢失的备份。
>
> **真源仍然是 CMS**（`https://cms.finddatatech.cloud`）。改内容请改 CMS 或
> `~/finddata/docs/xingyan/academy/`，不要改这里的副本——这里是只读快照。

| 文件 | 说明 |
| --- | --- |
| `yizuo-mandate-disclosure.zh.md` | 中文版《让智能体替你判断：委托状的三个旋钮》 |
| `yizuo-mandate-disclosure.en.md` | 英文版《Let the agent decide for you: the three dials of a mandate》 |
| `PUBLISH-CHECK.md` | 上线核验记录（标题/关键词判据、CMS 真源链路、重发命令） |

## 当前上线状态（2026-11-10 实测）

| 语言 | URL | 状态 |
| --- | --- | --- |
| 中文 | `/zh/research/academy/yizuo-mandate-disclosure/` | ✅ 在线（title 正确 + 18 处关键词命中） |
| 英文 | `/en/research/academy/yizuo-mandate-disclosure/` | ❌ 回退壳（HTTP 200，但返回站点首页 title、正文 0 命中） |

英文版待重发，需要 `XINGYAN_ADMIN_PW`：

```bash
export XINGYAN_ADMIN_PW='...'
python3 docs/xingyan/scripts/publish_course.py yizuo-mandate-disclosure \
  --doc docs/xingyan/academy/en/yizuo-mandate-disclosure.md --locales en
```

复验（两条都要过，只看状态码会得到假绿灯）：

```bash
u='https://www.finddatatech.cloud/en/research/academy/yizuo-mandate-disclosure/'
curl -sS "$u" | grep -oE '<title>[^<]*</title>'            # 期望课程标题，不是站点首页标题
curl -sS "$u" | grep -c 'decision mode\|disclose scope'    # 期望 > 0
```
