#!/usr/bin/env python3
"""doc-studio 生成后质检（postcheck）。

对生成的文档做结构自检，发现会导致"打开即翻车"的缺陷：打不开、无标题结构、
图片引用断裂、越界形状、空表。用法：

    python3 postcheck.py 文件1.docx 文件2.xlsx ...

每个文件输出 PASS 或 FAIL + 缺陷清单；任一 FAIL 则退出码 1。
本文件随技能体内嵌（fenced 代码块），由 agent 落盘到工作区执行。
"""
import sys
import zipfile


def check_zip(path):
    bad = zipfile.ZipFile(path).testzip()
    return None if bad is None else f"zip 内损坏条目: {bad}"


def check_docx(path):
    from docx import Document
    findings = []
    doc = Document(path)
    headings = [p for p in doc.paragraphs if p.style.name.startswith("Heading")]
    if not headings:
        findings.append("没有任何 Heading 样式段落——文档缺少标题结构")
    body = "\n".join(p.text for p in doc.paragraphs)
    if "目录" in body:
        xml = doc.element.xml
        if "TOC" not in xml and "instrText" not in xml:
            findings.append('出现"目录"字样但没有 TOC 域——目录是死文本，翻页后不会更新')
    try:
        n_img = len(doc.inline_shapes)
    except Exception as e:  # 断裂的图片引用在枚举时抛出
        findings.append(f"图片引用枚举失败（引用断裂）: {e}")
    else:
        for i, shp in enumerate(doc.inline_shapes):
            if shp.width == 0 or shp.height == 0:
                findings.append(f"图片 #{i + 1} 尺寸为零")
    if not doc.paragraphs:
        findings.append("正文为空")
    return findings


def check_xlsx(path):
    import openpyxl
    findings = []
    wb = openpyxl.load_workbook(path)
    if not wb.sheetnames:
        return ["工作簿没有任何工作表"]
    for ws in wb.worksheets:
        if ws.max_row < 1 or (ws.max_row == 1 and ws.max_column == 1 and
                               ws.cell(1, 1).value in (None, "")):
            findings.append(f"工作表 {ws.title!r} 为空")
        if ws.title in ("Sheet", "Sheet1", "Worksheet") and len(wb.sheetnames) > 1:
            findings.append(f"存在未重命名的默认表名 {ws.title!r}")
        for rng in ws.merged_cells.ranges:
            if rng.min_row == rng.max_row and rng.min_col == rng.max_col:
                findings.append(f"{ws.title}!{rng} 单格合并无意义")
    return findings


def check_pptx(path):
    from pptx import Presentation
    from pptx.util import Emu
    findings = []
    prs = Presentation(path)
    w, h = prs.slide_width, prs.slide_height
    if abs(w / h - 16 / 9) > 0.01:
        findings.append(f"画幅不是 16:9（{Emu(w).inches:.2f}x{Emu(h).inches:.2f} 英寸），投影会两侧留白")
    if not len(prs.slides):
        findings.append("没有任何幻灯片")
    for idx, slide in enumerate(prs.slides, 1):
        if not slide.shapes:
            findings.append(f"第 {idx} 页没有任何形状")
        for shp in slide.shapes:
            try:
                l, t, sw, sh = shp.left, shp.top, shp.width, shp.height
            except (TypeError, AttributeError):
                continue
            if l is None or t is None:
                continue
            tol = Emu(int(0.05 * 914400)).emu
            if l < -tol or t < -tol or (l + (sw or 0)) > w + tol or (t + (sh or 0)) > h + tol:
                findings.append(f"第 {idx} 页形状 {shp.shape_type} 越出画布（left={Emu(l).inches:.2f}in top={Emu(t).inches:.2f}in）")
                break
    return findings


def postcheck(path):
    findings = []
    lower = path.lower()
    try:
        size_ok = __import__("os").path.getsize(path) > 0
    except OSError as e:
        return [f"文件不可读: {e}"]
    if not size_ok:
        return ["文件为空（0 字节）"]
    try:
        zerr = check_zip(path)
        if zerr:
            return [zerr]
    except zipfile.BadZipFile:
        return ["不是有效的 OOXML（zip）文件"]
    try:
        if lower.endswith(".docx"):
            findings = check_docx(path)
        elif lower.endswith(".xlsx"):
            findings = check_xlsx(path)
        elif lower.endswith(".pptx"):
            findings = check_pptx(path)
        else:
            return [None]  # 未登记的类型不检查也不拦
    except Exception as e:
        findings = [f"文件无法以 office 库打开（极可能损坏）: {type(e).__name__}: {e}"]
    return findings


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    failed = False
    for path in argv[1:]:
        findings = postcheck(path)
        if findings == [None]:
            print(f"SKIP  {path}（该类型不在检查范围）")
            continue
        if findings:
            failed = True
            print(f"FAIL  {path}")
            for f in findings:
                print(f"      - {f}")
        else:
            print(f"PASS  {path}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
