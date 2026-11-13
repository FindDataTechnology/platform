#!/usr/bin/env bash
# 构建桩 SDK。macOS 出 .dylib，Linux 出 .so，Windows 需 MSVC/MinGW 另编。
#
#   ./build.sh            # 按当前平台构建到 ./build/
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

case "$(uname -s)" in
  Darwin)
    OUT=build/libWeWorkFinanceSdk_C.dylib
    clang -shared -fPIC -O2 -o "$OUT" stub_sdk.c
    ;;
  Linux)
    OUT=build/libWeWorkFinanceSdk_C.so
    cc -shared -fPIC -O2 -o "$OUT" stub_sdk.c
    ;;
  *)
    echo "unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

echo "built: $OUT"
echo "exported symbols:"
# 列出全部导出符号（不加过滤）：桩的价值就在于"符号集合与官方一致"，
# 用 grep 挑几个名字打出来，会漏掉那些"本来该有、但我们忘了导出"的。
case "$(uname -s)" in
  Darwin) nm -gU "$OUT" | awk '{print $3}' | grep "^_" | sed 's/^_//' | sort | sed 's/^/  /' ;;
  *)      nm -D --defined-only "$OUT" | awk '{print $3}' | sort | sed 's/^/  /' ;;
esac
