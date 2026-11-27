#!/usr/bin/env python3
# ── 寻数壹座 图标资产生成器 ─────────────────────────────────────────────────
#
# 两种标（决议 2026-10-28，用户亲授）：
#   大图标/品牌面   = 白底 + 黑色「壹座」字标 + 一根横线（assets/brand/icon.svg）
#   软件图标本体     = 白底 + 一根粗些的「一」横线，不要名字（所有打包/安装/层级切换图）
#
# 字标经 fontTools 从系统 PingFang/Hiragino 提取字形轮廓写成 path —— 任何
# 机器跑出来的位图/矢量完全一致，不依赖渲染方是否有中文字体。
#
# 产出（都是被 git 跟踪或构建消费的既有路径，本脚本全面覆写）：
#   assets/brand/icon.svg                 大图标主矢量（白底，带名字，品牌/文档用）
#   assets/brand/icon-mark.svg            大图标纯标记矢量（无背景）
#   assets/brand/icon-app.svg             软件图标主矢量（白底，只一根「一」）
#   build/icon.png                        1024 软件图标（electron-builder win/lin 源）
#   build/icon.icns                       macOS 全套（iconutil；gitignored，本地 dist 用）
#   app/assets/images/icon.png                             1024 软件图标
#   app/assets/images/android-icon-foreground.png          1024 安全区（仅一根「一」）
#   app/assets/images/android-icon-background.png          1024 纯白
#   app/assets/images/android-icon-monochrome.png          1024 黑「一」，透明底
#   app/assets/images/favicon.png                          64 软件图标
#   app/assets/images/splash-icon.png                      1024 安全区（仅一根「一」）
#   app/assets/expo.icon/Assets/expo-symbol 2.svg          纯「一」矢量（iOS 用）
#   web/public/icon.svg                   favicon（软件图标=一根「一」）
#
# 用法：python3 scripts/brand-icon.py         （需要 PIL、fontTools、rsvg-convert、iconutil）

import math
import os
import shutil
import subprocess
import sys

from PIL import Image
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

WORD = "壹座"          # 改四字「寻数壹座」只动这一处；横照会等比拉宽
FONT_CANDIDATES = [
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", "Hiragino Sans GB", "W6"),
    ("/System/Library/Fonts/STHeiti Medium.ttc", "Heiti SC", "W6"),
    ("/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", "Hiragino Sans", "W6"),
    ("/System/Library/Fonts/PingFang.ttc", "PingFang SC", "Semibold"),
]
BLOCK = "#000000"
GROUND = "#FFFFFF"
CANVAS = 1024

# 布局（canvas 坐标，四点方框留给 OS 圆角遮罩吃）：
WORDS_WIDE = 0.66 * CANVAS   # 字标宽 66%
BAR_WIDE = 0.52 * CANVAS     # 横线 = 宇标宽的 ~80%（放心中间量）
BAR_HIGH = 0.045 * CANVAS    # 横线厚 4.5%
BAR_GAP = 0.115 * CANVAS     # 字标底线到横线顶的距离

EXPORTS = {
    "master_svg": "assets/brand/icon.svg",
    "mark_svg": "assets/brand/icon-mark.svg",
    "app_svg": "assets/brand/icon-app.svg",
    "symbol_svg": "app/assets/expo.icon/Assets/expo-symbol 2.svg",
    "favicon_svg": "web/public/icon.svg",
}

# 软件图标本体（决议：不要名字）——一根粗横线「一」，x 居中，y 落在品牌
# 基准线（即字标图里横线的同一位置），保证小尺寸依然可读。
APP_BAR_WIDE = 0.58 * CANVAS
APP_BAR_HIGH = 0.11 * CANVAS
APP_BAR_Y = 0.635 * CANVAS  # 粗线中心 y ≈ 与主图标横线同一水平线


def pick_font():
    """按候选顺序找‘覆盖 WORD 代码点、字重面容匹配’的字体面。"""
    for path, want_family, want_style in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        collection = TTCollection(path, lazy=True)
        for f in collection.fonts:
            name = f["name"]
            full = (name.getName(4, 3, 1, 0x409) or "").toUnicode()
            style = (name.getName(2, 3, 1, 0x409) or "").toUnicode()
            if want_family in full and want_style in style:
                cmap = f.getBestCmap()
                if all(ord(c) in cmap for c in WORD):
                    return f
        # 有该家族但不匹配字重 → 收第一个能画出字的
        for f in collection.fonts:
            cmap = f.getBestCmap()
            if all(ord(c) in cmap for c in WORD):
                return f
    raise SystemExit("没有找到含所需字形的系统字体")


def glyph_paths(font, word):
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    glyphs = []
    x = 0.0
    for ch in word:
        name = gs[ch] if ch in gs else font.getBestCmap()[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        advance, _ = hmtx[name]
        glyphs.append({"path": pen.getCommands(), "advance": float(advance), "x": x})
        x += advance
    return glyphs, x, gs


def compose(word, font, target_width, bar_width, bar_thickness, gap_above_bar):
    glyphs, total_advance, gs = glyph_paths(font, word)
    # 两个字形的联合 bbox（按各自 advance 平移后求并集）
    word_bbox = [math.inf, math.inf, -math.inf, -math.inf]
    for ch, g in zip(word, glyphs):
        name = font.getBestCmap()[ord(ch)]
        bounds = BoundsPen(gs)
        gs[name].draw(bounds)
        if bounds.bounds is None:
            continue
        x0 = g["x"] + bounds.bounds[0]
        y0 = bounds.bounds[1]
        x1 = g["x"] + bounds.bounds[2]
        y1 = bounds.bounds[3]
        word_bbox[0] = min(word_bbox[0], x0)
        word_bbox[1] = min(word_bbox[1], y0)
        word_bbox[2] = max(word_bbox[2], x1)
        word_bbox[3] = max(word_bbox[3], y1)
    scale = target_width / total_advance
    cx = (word_bbox[0] + word_bbox[2]) / 2.0
    cy = (word_bbox[1] + word_bbox[3]) / 2.0
    # svg_y = ty - scale*glyph_y（path 内部已做 Y 翻转），故中心公式是 +cy，
    # 顶/top = ty - scale*y1，底/bottom = ty - scale*y0
    words_center_y = CANVAS * (0.5 - (bar_thickness + gap_above_bar) / 2.0 / CANVAS - 0.035)
    tx = CANVAS / 2.0 - scale * cx
    ty = words_center_y + scale * cy
    bar_y = (ty - scale * word_bbox[1]) + gap_above_bar
    bar_x = CANVAS / 2.0 - bar_width / 2.0
    return {
        "glyphs": glyphs,
        "scale": scale,
        "tx": tx,
        "ty": ty,
        "bar": (bar_x, bar_y, bar_width, bar_thickness),
        "word_bbox": word_bbox,
    }


def svg_doc(comp, blocks=BLOCK, ground=GROUND, show_bar=True, show_ground=True):
    paths = []
    if show_ground:
        paths.append(f'<rect width="{CANVAS}" height="{CANVAS}" fill="{ground}"/>')
    for ch, g in zip(WORD, comp["glyphs"]):
        name_x = comp["tx"] + comp["scale"] * g["x"]
        paths.append(
            f'<path transform="translate({name_x:.2f},{comp["ty"]:.2f}) '
            f'scale({comp["scale"]:.4f},-{comp["scale"]:.4f})" d="{g["path"]}" fill="{blocks}"/>'
        )
    if show_bar:
        x, y, w, h = comp["bar"]
        paths.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" fill="{blocks}"/>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}">\n'
        + "\n".join(paths)
        + "\n</svg>\n"
    )


def rasterize(svg_path, png_path, size):
    subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", png_path, svg_path],
        check=True,
    )


def icns_from_square(png_path, out_path, workdir):
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    iconset = os.path.join(workdir, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    names = {
        16: ["icon_16x16.png"],
        32: ["icon_16x16@2x.png", "icon_32x32.png"],
        64: ["icon_32x32@2x.png"],
        128: ["icon_128x128.png"],
        256: ["icon_128x128@2x.png", "icon_256x256.png"],
        512: ["icon_256x256@2x.png", "icon_512x512.png"],
        1024: ["icon_512x512@2x.png"],
    }
    img = Image.open(png_path)
    for size, files in names.items():
        resized = img.resize((size, size), Image.LANCZOS)
        for f in files:
            resized.save(os.path.join(iconset, f))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out_path], check=True)


def bbox_of_png(png_path):
    img = Image.open(png_path).convert("RGB")
    bw = img.getbbox()
    # 反白 bbox
    from PIL import ImageChops
    inverse = ImageChops.invert(img.convert("L")).point(lambda p: 255 if p > 8 else 0, "L")
    return inverse.getbbox(), img.size


def app_bar_svg(ground=GROUND, show_ground=True):
    """软件图标本体：居中一根「一」。safe 变体靠调用方给的透明度/尺寸。"""
    x = CANVAS / 2.0 - APP_BAR_WIDE / 2.0
    y = APP_BAR_Y - APP_BAR_HIGH / 2.0
    parts = [f'<rect x="{x:.2f}" y="{y:.2f}" width="{APP_BAR_WIDE:.2f}" height="{APP_BAR_HIGH:.2f}" fill="{BLOCK}"/>']
    if show_ground:
        parts.insert(0, f'<rect width="{CANVAS}" height="{CANVAS}" fill="{ground}"/>')
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}">\n'
        + "\n".join(parts)
        + "\n</svg>\n"
    )


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    font = pick_font()
    comp = compose(WORD, font, WORDS_WIDE, BAR_WIDE, BAR_HIGH, BAR_GAP)

    os.makedirs("assets/brand", exist_ok=True)
    full = svg_doc(comp, ground=GROUND, show_ground=True)
    mark = svg_doc(comp, ground=GROUND, show_ground=False)
    for path, text in (
        (EXPORTS["master_svg"], full),
        (EXPORTS["mark_svg"], mark),
        (EXPORTS["app_svg"], app_bar_svg()),
        (EXPORTS["symbol_svg"], app_bar_svg(show_ground=False)),
        (EXPORTS["favicon_svg"], app_bar_svg()),
    ):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)

    # 1) 桌面：软件图标（一根「一」，白底）
    os.makedirs("build", exist_ok=True)
    rasterize(EXPORTS["app_svg"], "build/icon.png", CANVAS)
    icns_from_square("build/icon.png", "build/icon.icns", "build")

    # 2) App 全家桶（软件图标同样不要名字）
    app_dir = "app/assets/images"
    os.makedirs(app_dir, exist_ok=True)
    rasterize(EXPORTS["app_svg"], f"{app_dir}/icon.png", CANVAS)
    safe_svg = "build/.icon-app-safe.svg"
    with open(safe_svg, "w", encoding="utf-8") as fh:
        fh.write(app_bar_svg(show_ground=False))
    rasterize(safe_svg, f"{app_dir}/android-icon-foreground.png", CANVAS)
    rasterize(safe_svg, f"{app_dir}/android-icon-monochrome.png", CANVAS)
    rasterize(safe_svg, f"{app_dir}/splash-icon.png", CANVAS)
    Image.new("RGB", (CANVAS, CANVAS), GROUND).save(f"{app_dir}/android-icon-background.png")
    rasterize(EXPORTS["app_svg"], f"{app_dir}/favicon.png", 64)

    # 3) 保守的验证输出
    bbox, sz = bbox_of_png("build/icon.png")
    print(f"build/icon.png {sz}, ink bbox={bbox}")
    for f in ["icon.png", "icon.icns"]:
        print("build/" + f, os.path.getsize(os.path.join("build", f)), "bytes")


if __name__ == "__main__":
    main()
