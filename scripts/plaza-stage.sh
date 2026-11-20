#!/usr/bin/env bash
# plaza-stage.sh — 把一个 plaza 部署包成套落到站点根（fix-supply-machine-faces 2.1）
#
# 用法（在目标机上执行，deploy-plaza.sh 通过 stdin 送过来）：
#   bash plaza-stage.sh <tar包> <站点根> [staging目录]
#
# 为什么单独成文件：deploy-plaza.sh 通过 ssh 把它送到目标机，本地测试也跑
# 同一个文件——落位逻辑只有一份，测试测的不是复制品。
#
# 语义：
#   1. 先解到同级 staging 目录，绝不直接在站点根上解包；
#   2. 在 staging 里把四个根机器面（llms.txt / llms-full.txt / catalog.json /
#      robots.txt）写成 .tmp，缺任何一份导出物即失败退出（不落半套）；
#   3. 站点内容（页面/资源/生成物）整体覆盖，四个机器面最后逐个 mv —— mv 在
#      同一文件系统上是原子的，所以线上永远不会看到「新的 llms.txt + 旧的
#      catalog.json」这种半套状态；
#   4. 结束时清掉 staging。
set -euo pipefail

TAR="${1:?用法: plaza-stage.sh <tar包> <站点根> [staging目录]}"
PLAZA_DIR="${2:?用法: plaza-stage.sh <tar包> <站点根> [staging目录]}"
STAGE="${3:-${PLAZA_DIR%/}.stage.$$}"

MACHINE_FACES=(llms.txt llms-full.txt catalog.json)
SITE_ITEMS=(index.html style.css script.js locales generated deploy)

rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

tar -xzf "$TAR" -C "$STAGE"

# 根机器面：三份来自导出物，robots.txt 由本脚本生成
# 注意：变量一律写 ${f}——远端若是 C locale，`$f：` 会把全角冒号的字节
# 当成变量名的一部分（f\xef\xbc\x9a），set -u 直接报 unbound。
for f in "${MACHINE_FACES[@]}"; do
  if [ ! -s "$STAGE/generated/$f" ]; then
    echo "缺 generated/${f}：导出物不全，拒绝落位" >&2
    exit 1
  fi
  cp "$STAGE/generated/$f" "$STAGE/$f.tmp"
done
printf 'User-agent: *\nAllow: /\n# AI agents: start at /llms.txt — the self-contained site index\n' \
  > "$STAGE/robots.txt.tmp"

mkdir -p "$PLAZA_DIR"

# 站点内容整体覆盖
for item in "${SITE_ITEMS[@]}"; do
  if [ -e "$STAGE/$item" ]; then
    rm -rf "${PLAZA_DIR:?}/$item"
    mv "$STAGE/$item" "$PLAZA_DIR/$item"
  fi
done

# 四个机器面最后逐个原子落位
for f in "${MACHINE_FACES[@]}" robots.txt; do
  mv -f "$STAGE/$f.tmp" "$PLAZA_DIR/$f"
done

echo "   已落位：$(ls "$PLAZA_DIR" | tr '\n' ' ')"
