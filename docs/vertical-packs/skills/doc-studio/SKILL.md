---
name: doc-studio
description: 文档工坊——Word/Excel/PPT 商务文档生成与编辑。当用户要求生成报告、表格、演示文稿、文档交付物，或要求编辑/转换上传的 docx/xlsx/pptx 文件时使用。产出符合中式商务版式的成稿，生成后自动质检。
---

# 文档工坊（doc-studio）

你是资深商务文档工程师。本技能覆盖三类生成场景（Word 报告 / Excel 工作簿 / PPT 演示）与一类编辑场景（用户上传件）。按路由推进，不跳步。

## 路由

| 用户意图 | 走哪节 |
|---|---|
| 写报告 / 白皮书 / 总结 / 方案 | §商务报告 |
| 做表 / 数据整理 / 指标看板 | §数据工作簿 |
| 做 PPT / 汇报 / 讲稿 | §汇报演示 |
| 改 / 填 / 转换已上传的文件 | §编辑上传件 |
| 不确定形态 | 按交付目的建议形态，确认后开工 |

## 硬规则（任何场景都不得违反）

1. **产出落工作区**：全部文件写到当前工作目录（相对路径），绝不写 `/tmp`——平台只对工作区文件提供预览、下载与入藏。
2. **原件不可变**：编辑用户上传件时，原件只读；改完存 `<原名>_updated.<ext>`。用户明确要求原地改时，先复制 `<原名>_backup.<ext>` 再动手。
3. **封面只用配方**：§封面配方 R1–R4 之外不得自由发挥封面代码（浮动文本框、形状定位在 MS Office 与 WPS 的渲染差异是翻车首因）。要改风格，改配色的参数，不改结构。
4. **生成即质检**：每份文件生成后必须执行 §postcheck，FAIL 项修复后重检，不许带病交付；postcheck 无法覆盖的版式问题（配色观感、字号层级），自查一遍再交付。
5. **字体本地优先**：中文标题「微软雅黑」、中文正文「等线」、西文「Calibri」，经 `set_font` 的 eastAsia 通道写入；不得使用用户环境大概率没有的装饰字体。

## 环境与依赖

运行时镜像已内置 python3 与 python-docx / openpyxl / python-pptx / mammoth，直接 `python3 - <<'EOF'` 或写脚本执行，禁止任何 pip 安装。

## 公共助手（所有场景共用）

```python
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

def set_font(run, name_cn="等线", name_en="Calibri", size=11, bold=False, color=None):
    """中英文字体必须分别设置：漏掉 w:eastAsia，中文在 MS Office 会回退宋体。"""
    run.font.name = name_en
    run.font.size = Pt(size)
    run.font.bold = bold
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts"); rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name_cn)
    if color:
        run.font.color.rgb = RGBColor.from_string(color)

def shade_cell(cell, hex_color):
    """单元格底色——封面背景的唯一可靠手段。"""
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:fill"), hex_color)
    tcpr.append(shd)

def no_borders(table):
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}"); el.set(qn("w:val"), "none")
        borders.append(el)
    table._tbl.tblPr.append(borders)

def fixed_row_height(row, cm):
    trpr = row._tr.get_or_add_trPr()
    trheight = OxmlElement("w:trHeight")
    trheight.set(qn("w:val"), str(int(cm * 567))); trheight.set(qn("w:hRule"), "exact")
    trpr.append(trheight)
```

## 设计系统

三套配色按文档气质选择，全文（封面、表头、图表、PPT 强调色）只用所选一套：

| 配色 | primary | accent | light | 适用 |
|---|---|---|---|---|
| 靛青（默认） | 1F4E79 | 2E75B6 | DEEBF7 | 商务报告、经营分析 |
| 石墨 | 404040 | 595959 | F2F2F2 | 咨询、技术评估 |
| 绛红 | 8B1A1A | C00000 | FBEAEA | 汇报、政务风格 |

版式基线：docx 页边距上下 2.5cm 左右 2.8cm；标题阶梯 H1 16pt / H2 14pt / H3 12pt，正文 11pt，行距 1.3；表格表头一律 light 底 + 加粗，正文行不加底色。图表色序（echarts 与 office 图表通用）：`[primary, accent, F2A900, 6C8EBF, 948A54]`，禁止超过五个数据系列的彩虹配色。

## 封面配方（R1–R4）

选型：正式报告 → R1；方案/评估类 → R2；数据简报/周报月报 → R3；PPT 标题页 → R4。以下代码即配方本体，只允许替换文案与颜色参数。

**R1 深蓝商务**（参数：title, subtitle, meta_lines, primary, on_primary）

```python
def build_cover_r1(path, title, subtitle=None, meta_lines=None, primary="1F4E79", on_primary="FFFFFF"):
    doc = Document()
    doc.sections[0].top_margin = Cm(2.5)
    table = doc.add_table(rows=3, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    no_borders(table)
    fixed_row_height(table.rows[0], 6.5)
    c = table.cell(0, 0); shade_cell(c, primary)
    p = c.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(title); set_font(r, size=26, bold=True, color=on_primary)
    fixed_row_height(table.rows[1], 2.2)
    c = table.cell(1, 0); shade_cell(c, primary)
    if subtitle:
        p = c.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(subtitle); set_font(r, size=14, color=on_primary)
    fixed_row_height(table.rows[2], 4.0)
    c = table.cell(2, 0)
    for i, line in enumerate(meta_lines or []):
        p = c.paragraphs[0] if i == 0 else c.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(line); set_font(r, size=10.5, color="666666")
    doc.save(path)
```

**R2 极简横线**（参数：title, subtitle, meta_lines, accent——大标题左对齐，顶部一根细色条）

```python
def build_cover_r2(path, title, subtitle=None, meta_lines=None, accent="2E75B6"):
    doc = Document()
    for _ in range(6):
        doc.add_paragraph()
    bar = doc.add_table(rows=1, cols=1)
    no_borders(bar)
    fixed_row_height(bar.rows[0], 0.12)
    shade_cell(bar.cell(0, 0), accent)
    doc.add_paragraph().paragraph_format.space_after = Pt(18)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r = p.add_run(title); set_font(r, name_cn="微软雅黑", size=30, bold=True, color="262626")
    if subtitle:
        p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(10)
        r = p.add_run(subtitle); set_font(r, size=14, color="595959")
    p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(28)
    r = p.add_run("\n".join(meta_lines or [])); set_font(r, size=10.5, color="8C8C8C")
    doc.save(path)
```

**R3 数据简报**（参数：title, kpis=[(数值,标签),...] 3–4 格, meta_lines, primary, accent light 底 KPI 卡）

```python
def build_cover_r3(path, title, kpis=None, meta_lines=None, primary="1F4E79", accent="DEEBF7"):
    doc = Document()
    doc.sections[0].top_margin = Cm(2.0)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r = p.add_run(title); set_font(r, name_cn="微软雅黑", size=24, bold=True, color=primary)
    doc.add_paragraph()
    cards = doc.add_table(rows=2, cols=max(len(kpis or []), 1))
    cards.alignment = WD_TABLE_ALIGNMENT.CENTER
    no_borders(cards)
    for j, (num, label) in enumerate(kpis or []):
        c = cards.cell(0, j); shade_cell(c, accent)
        p = c.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(str(num)); set_font(r, size=20, bold=True, color=primary)
        c2 = cards.cell(1, j); shade_cell(c2, accent)
        p = c2.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(str(label)); set_font(r, size=9, color="404040")
    doc.add_paragraph()
    for line in meta_lines or []:
        p = doc.add_paragraph()
        r = p.add_run(line); set_font(r, size=10, color="8C8C8C")
    doc.save(path)
```

**R4 演示标题页**（pptx；参数：title, subtitle, meta, primary——深底白字，16:9。pptx 的 RGBColor 与 docx 同名，导入必须收在函数体内，避免遮蔽）

```python
def build_cover_r4(path, title, subtitle=None, meta=None, primary="1F4E79"):
    from pptx import Presentation
    from pptx.util import Inches, Pt as PPt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN
    prs = Presentation()
    prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白版式
    bg = slide.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)
    bg.fill.solid(); bg.fill.fore_color.rgb = RGBColor.from_string(primary)
    bg.line.fill.background()
    box = slide.shapes.add_textbox(Inches(1.2), Inches(2.6), Inches(10.9), Inches(1.4))
    p = box.text_frame.paragraphs[0]; p.alignment = PP_ALIGN.LEFT
    r = p.add_run(); r.text = title
    r.font.size = PPt(40); r.font.bold = True
    r.font.color.rgb = RGBColor.from_string("FFFFFF")
    if subtitle:
        b2 = slide.shapes.add_textbox(Inches(1.2), Inches(4.1), Inches(10.9), Inches(0.8))
        r2 = b2.text_frame.paragraphs[0].add_run(); r2.text = subtitle
        r2.font.size = PPt(18); r2.font.color.rgb = RGBColor.from_string("D9E2F3")
    if meta:
        b3 = slide.shapes.add_textbox(Inches(1.2), Inches(6.6), Inches(10.9), Inches(0.5))
        r3 = b3.text_frame.paragraphs[0].add_run(); r3.text = meta
        r3.font.size = PPt(12); r3.font.color.rgb = RGBColor.from_string("B4C7E7")
    prs.save(path)
```

## 商务报告（docx）

结构骨架：封面（R1/R2）→ 摘要（300 字内说清结论）→ 目录（必须是 TOC 域，禁止手打章节名）→ 正文（H1 章节编号「一、二、…」，H2「1.1」）→ 结论与建议 → 附录。数据用表格（Table Grid + light 表头），引用口径在表注写明。

目录域配方（死文本目录翻页即废，postcheck 会拦）：

```python
def add_toc(doc):
    doc.add_heading("目录", level=1)
    p = doc.add_paragraph()
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), r'TOC \o "1-2" \h \z \u')
    ir = OxmlElement("w:r"); it = OxmlElement("w:t")
    it.text = "（在 Word 中按 F9 更新目录）"
    ir.append(it); fld.append(ir)
    p._p.append(fld)
```

写作要求：每个 H1 章节第一句是该章结论；数据句必须带出处在括号里；禁止空洞排比句。

## 数据工作簿（xlsx）

结构骨架：每簿一个主题；数据表名实义（禁止 Sheet1）；第一行表头加粗 + light 底；指标列写公式（`=(B2-C2)/B2`）而非硬编码值，**公式行号用显式循环变量（`f"=(B{i}-C{i})/B{i}"`），禁止拿 `ws.max_row` 当行号——它在 append 前求值，永远差一行**；超阈值条件格式（红 `FFC7CE`）标异常；配一张图表，**锚在数据块下方（如 `ws.add_chart(chart, "A9")`）而非右侧——右侧锚位会被打印分页从中间切开**。数字列固定小数位，日期用 `YYYY-MM` 文本或日期格式，不混排。

```python
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Font, PatternFill
from openpyxl.chart import BarChart, Reference
# 表头样式 + 条件格式 + 图表的完整示例见本节说明，按需组合：
# c.font = Font(bold=True); c.fill = PatternFill("solid", fgColor="DEEBF7")
# ws.conditional_formatting.add("D2:D7", CellIsRule(operator="lessThan",
#     formula=["0.4"], fill=PatternFill("solid", fgColor="FFC7CE")))
# chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=7), titles_from_data=True)
# chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=7))
```

## 汇报演示（pptx）

结构骨架：标题页（R4）→ 目录页 → 每页一个论点（页标题即论点句，如「营收同比增长 38.2%」而非「经营情况」）→ 要点不超过 5 条、每条一行 → 收尾「下一步」页。全篇 16:9；正文字号 ≥18pt；深底页文字用 white/D9E2F3，浅底页用 primary/404040。

## 编辑上传件

1. `fetch_document_file` 把原件取进工作区（工具在资料库 MCP；没有原件会明确报错，此时告知用户只能基于抽取文本处理）。
2. 读：docx 用 `mammoth.convert_to_html`（保结构）；xlsx/pptx 用 openpyxl/python-pptx 直读。
3. 改：在内存对象上改，另存 `<原名>_updated.<ext>`（硬规则 2）。
4. 转文本需求（docx→MD）：mammoth 输出 HTML 后转 MD，图片引用保持相对路径。
5. 生成/转换产物同样过 postcheck。

## postcheck（生成后质检，硬规则 4 的执行器）

把下面的代码写到工作区 `postcheck.py` 并 `python3 postcheck.py <产出文件...>`。退出码 1 = 有 FAIL，逐项修复后重跑。

```python
#!/usr/bin/env python3
import sys, zipfile

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
    except Exception as e:
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
        if ws.max_row < 1 or (ws.max_row == 1 and ws.max_column == 1 and ws.cell(1, 1).value in (None, "")):
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
            tol = int(0.05 * 914400)
            if l < -tol or t < -tol or (l + (sw or 0)) > w + tol or (t + (sh or 0)) > h + tol:
                findings.append(f"第 {idx} 页形状越出画布（left={Emu(l).inches:.2f}in top={Emu(t).inches:.2f}in）")
                break
    return findings

def postcheck(path):
    import os
    lower = path.lower()
    try:
        if os.path.getsize(path) == 0:
            return ["文件为空（0 字节）"]
    except OSError as e:
        return [f"文件不可读: {e}"]
    try:
        zerr = check_zip(path)
        if zerr:
            return [zerr]
    except zipfile.BadZipFile:
        return ["不是有效的 OOXML（zip）文件"]
    try:
        if lower.endswith(".docx"):
            return check_docx(path)
        if lower.endswith(".xlsx"):
            return check_xlsx(path)
        if lower.endswith(".pptx"):
            return check_pptx(path)
        return [None]
    except Exception as e:
        return [f"文件无法以 office 库打开（极可能损坏）: {type(e).__name__}: {e}"]

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 postcheck.py 文件1.docx 文件2.xlsx ...")
        sys.exit(2)
    failed = False
    for path in sys.argv[1:]:
        findings = postcheck(path)
        if findings == [None]:
            print(f"SKIP  {path}（该类型不在检查范围）")
        elif findings:
            failed = True
            print(f"FAIL  {path}")
            for f in findings:
                print(f"      - {f}")
        else:
            print(f"PASS  {path}")
    sys.exit(1 if failed else 0)
```
