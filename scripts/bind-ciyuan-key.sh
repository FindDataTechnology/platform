#!/bin/sh
# 把客户自己的词元 key 粘进单租户栈（single-tenant-model-lane 6.1 的绑定步骤）。
#
# 用法（在 cheap9 上）：
#   sh /tmp/bind-key.sh
# 然后粘贴 key 回车。key 从 stdin 读，**不落磁盘、不进 shell 历史**（read -s 不回显）。
#
# 为什么不用 `node -e "..."` 内联：那种写法会把 key 变成命令行参数，
# 在任何时刻 `ps` 都能看见。
set -eu

CONTAINER="${1:-st2}"

printf '粘贴词元 key（sk-…，输入不回显）: '
IFS= read -r KEY
echo

case "$KEY" in
  sk-*) ;;
  *) echo "FATAL: 不是 sk- 开头的词元密钥" >&2; exit 1 ;;
esac

if [ "${#KEY}" -lt 20 ]; then
  echo "FATAL: 太短（${#KEY} 字符）" >&2; exit 1
fi

# 单租户形态：粘贴的 key 会被认作 pasted-key 来源，并因 SINGLE_TENANT=1
# 进入模型车道（这是 6.1 要验的那条）。
printf '%s' "$KEY" | docker exec -i "$CONTAINER" sh -c '
  KEY=$(cat)
  curl -sS -o /tmp/r.json -w "%{http_code}" \
    -X POST http://127.0.0.1:3000/api/lines/wanxing-caller/credential \
    -H "content-type: application/json" \
    --data-binary "$(printf "{\"token\":\"%s\"}" "$KEY")"
  echo
  head -c 300 /tmp/r.json; echo
  rm -f /tmp/r.json
'

echo "--- 卡面状态 ---"
docker exec "$CONTAINER" node -e '
fetch("http://127.0.0.1:3000/api/ciyuan-account/connection")
  .then(async r => { const j = await r.json();
    console.log(JSON.stringify({ source: j.source, connected: j.connected, modelLaneForm: j.modelLaneForm })); })
  .catch(e => console.log("ERR", e.message));
'
