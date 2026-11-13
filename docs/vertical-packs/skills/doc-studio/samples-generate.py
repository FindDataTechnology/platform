#!/usr/bin/env python3
"""doc-studio 封面配方样张生成器（开发侧，不随包分发）。

每个配方就是技能体内 fenced 代码的逐字拷贝——在这里跑通才允许回填技能体。
产出样张供真机验证（VERIFICATION.md 台账）。
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# ── 公共助手（技能体"公共助手"节的逐字拷贝）────────────────────────────

def set_font(run, name_cn="等线", name_en="Calibri", size=11, bold=False,
             color=None):
    """中英文字体必须分别设置：w:eastAsia 不设，中文回退宋体是 MS Office
    兼容性问题之首。"""
    run.font.name = name_en
    run.font.size = Pt(size)
    run.font.bold = bold
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name_cn)
    if color:
        run.font.color.rgb = RGBColor.from_string(color)

def shade_cell(cell, hex_color):
    """单元格底色（封面背景的唯一可靠手段——浮动文本框/形状在 MS Office
    与 WPS 的渲染差异是封面兼容性问题的主要来源）。"""
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:fill"), hex_color)
    tcpr.append(shd)

def no_borders(table):
    tbl = table._tbl
    tblpr = tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "none")
        borders.append(el)
    tblpr.append(borders)

def fixed_row_height(row, cm):
    trpr = row._tr.get_or_add_trPr()
    trheight = OxmlElement("w:trHeight")
    trheight.set(qn("w:val"), str(int(cm * 567)))
    trheight.set(qn("w:hRule"), "exact")
    trpr.append(trheight)

# ── R1 深蓝商务封面 ────────────────────────────────────────────────────

def build_cover_r1(path, title, subtitle=None, meta_lines=None,
                   primary="1F4E79", on_primary="FFFFFF"):
    doc = Document()
    section = doc.sections[0]
    section.top_margin = Cm(2.5)
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

# ── R2 极简横线封面 ────────────────────────────────────────────────────

def build_cover_r2(path, title, subtitle=None, meta_lines=None,
                   accent="2E75B6"):
    doc = Document()
    for _ in range(6):
        doc.add_paragraph()
    bar = doc.add_table(rows=1, cols=1)
    no_borders(bar)
    fixed_row_height(bar.rows[0], 0.12)
    shade_cell(bar.cell(0, 0), accent)
    doc.add_paragraph().paragraph_format.space_after = Pt(18)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r = p.add_run(title); set_font(r, name_cn="微软雅黑", size=30, bold=True,
                                    color="262626")
    if subtitle:
        p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(10)
        r = p.add_run(subtitle); set_font(r, size=14, color="595959")
    p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(28)
    r = p.add_run("\n".join(meta_lines or []))
    set_font(r, size=10.5, color="8C8C8C")
    doc.save(path)

# ── R3 数据简报封面 ────────────────────────────────────────────────────

def build_cover_r3(path, title, kpis=None, meta_lines=None,
                   primary="1F4E79", accent="DEEBF7"):
    """kpis: [(数值, 标签), ...] 一行三至四格 KPI 卡。"""
    doc = Document()
    section = doc.sections[0]
    section.top_margin = Cm(2.0)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r = p.add_run(title); set_font(r, name_cn="微软雅黑", size=24, bold=True,
                                    color=primary)
    doc.add_paragraph()
    n = max(len(kpis or []), 1)
    cards = doc.add_table(rows=2, cols=n)
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

# ── R4 演示标题页（pptx）───────────────────────────────────────────────

def build_cover_r4(path, title, subtitle=None, meta=None,
                   primary="1F4E79"):
    from pptx import Presentation
    from pptx.util import Inches, Pt as PPt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白版式
    bg = slide.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)
    bg.fill.solid(); bg.fill.fore_color.rgb = RGBColor.from_string(primary)
    bg.line.fill.background()
    box = slide.shapes.add_textbox(Inches(1.2), Inches(2.6), Inches(10.9), Inches(1.4))
    tf = box.text_frame; p = tf.paragraphs[0]; p.alignment = PP_ALIGN.LEFT
    r = p.add_run(); r.text = title
    r.font.size = PPt(40); r.font.bold = True
    r.font.color.rgb = RGBColor.from_string("FFFFFF")
    if subtitle:
        box2 = slide.shapes.add_textbox(Inches(1.2), Inches(4.1), Inches(10.9), Inches(0.8))
        p2 = box2.text_frame.paragraphs[0]
        r2 = p2.add_run(); r2.text = subtitle
        r2.font.size = PPt(18); r2.font.color.rgb = RGBColor.from_string("D9E2F3")
    if meta:
        box3 = slide.shapes.add_textbox(Inches(1.2), Inches(6.6), Inches(10.9), Inches(0.5))
        p3 = box3.text_frame.paragraphs[0]
        r3 = p3.add_run(); r3.text = meta
        r3.font.size = PPt(12); r3.font.color.rgb = RGBColor.from_string("B4C7E7")
    prs.save(path)

# ── 生成样张 ───────────────────────────────────────────────────────────

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
os.makedirs(out, exist_ok=True)
build_cover_r1(f"{out}/R1-深蓝商务.docx", "二〇二六年度经营分析报告",
               subtitle="找数科技 · 数据智能事业部",
               meta_lines=["编制：数据分析组", "日期：2026 年 10 月", "密级：内部"])
build_cover_r2(f"{out}/R2-极简横线.docx", "供应链数字化转型评估",
               subtitle="现状、差距与三年路径",
               meta_lines=["找数科技咨询", "2026 年 10 月"])
build_cover_r3(f"{out}/R3-数据简报.docx", "十月经营速览",
               kpis=[("1.24亿", "当月营收"), ("38.2%", "同比增速"), ("91.5", "NPS")],
               meta_lines=["数据截至 2026-10-07 · 来源：经营分析平台"])
build_cover_r4(f"{out}/R4-演示标题.pptx", "萬星平台年度汇报",
               subtitle="从能力建设到商业闭环", meta="汇报人：FindData · 2026.10")
for f in sorted(os.listdir(out)):
    print("OK", f, os.path.getsize(os.path.join(out, f)), "bytes")

# ── 三场景完整成稿样张（3.4 交付物，postcheck 必须 PASS）────────────────

def build_report_sample(path):
    from docx.oxml import OxmlElement
    doc = Document()
    build_cover_r1.__wrapped__ if False else None
    # 封面（R1 内嵌：与配方相同手法）
    table = doc.add_table(rows=3, cols=1); no_borders(table)
    fixed_row_height(table.rows[0], 6.5)
    c = table.cell(0, 0); shade_cell(c, "1F4E79")
    p = c.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("二〇二六年度经营分析报告"); set_font(r, size=26, bold=True, color="FFFFFF")
    fixed_row_height(table.rows[1], 2.2)
    c = table.cell(1, 0); shade_cell(c, "1F4E79")
    p = c.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("找数科技 · 数据智能事业部"); set_font(r, size=14, color="FFFFFF")
    fixed_row_height(table.rows[2], 4.0); c = table.cell(2, 0)
    p = c.paragraphs[0]; p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("编制：数据分析组 · 2026 年 10 月"); set_font(r, size=10.5, color="666666")
    doc.add_page_break()
    # 摘要
    doc.add_heading("摘要", level=1)
    doc.add_paragraph("本报告回顾 2026 年前三季度经营情况：营收稳步增长，"
                      "新签合同额创同期新高，客户满意度持续改善。")
    # 目录（TOC 域，非死文本）
    doc.add_heading("目录", level=1)
    p = doc.add_paragraph()
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), r'TOC \o "1-2" \h \z \u')
    ir = OxmlElement("w:r"); it = OxmlElement("w:t"); it.text = "（在 Word 中按 F9 更新目录）"
    ir.append(it); fld.append(ir)
    p._p.append(fld)
    # 正文
    doc.add_page_break()
    doc.add_heading("一、经营概览", level=1)
    doc.add_paragraph("前三季度累计营收同比增长 38.2%，各业务线均衡贡献。")
    doc.add_heading("1.1 关键指标", level=2)
    t = doc.add_table(rows=4, cols=3); t.style = "Table Grid"
    for j, h in enumerate(("指标", "数值", "同比")):
        c = t.cell(0, j); shade_cell(c, "DEEBF7")
        r = c.paragraphs[0].add_run(h); set_font(r, bold=True)
    for i, row in enumerate((("营收", "1.24 亿", "+38.2%"), ("新签合同", "8,900 万", "+21.0%"),
                             ("NPS", "91.5", "+3.2"))):
        for j, v in enumerate(row):
            r = t.cell(i + 1, j).paragraphs[0].add_run(v); set_font(r)
    doc.add_heading("二、分业务分析", level=1)
    doc.add_paragraph("平台业务、数据业务与生态业务三线并进，详见下章图表拆解。")
    doc.save(path)

def build_workbook_sample(path):
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    from openpyxl.formatting.rule import CellIsRule
    from openpyxl.chart import BarChart, Reference
    wb = openpyxl.Workbook()
    ws = wb.active; ws.title = "月度数据"
    ws.append(["月份", "营收（万）", "成本（万）", "毛利率"])
    for i, (m, rev, cost) in enumerate(((1, 860, 512), (2, 905, 530), (3, 1020, 570), (4, 1105, 601),
                         (5, 1180, 628), (6, 1240, 650)), start=2):
        ws.append([f"2026-{m:02d}", rev, cost, f"=(B{i}-C{i})/B{i}"])
    for c in ws[1]:
        c.font = Font(bold=True); c.fill = PatternFill("solid", fgColor="DEEBF7")
    ws.column_dimensions["A"].width = 12
    ws.conditional_formatting.add(f"D2:D{ws.max_row}",
        CellIsRule(operator="lessThan", formula=["0.4"],
                   fill=PatternFill("solid", fgColor="FFC7CE")))
    chart = BarChart(); chart.title = "月度营收"
    chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=ws.max_row), titles_from_data=True)
    chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=ws.max_row))
    ws.add_chart(chart, "A9")  # 数据下方：右侧锚位被打印分页从中间切开（真机渲染实证）
    wb.save(path)

def build_deck_sample(path):
    from pptx import Presentation
    from pptx.util import Inches, Pt as PPt
    from pptx.dml.color import RGBColor
    from pptx.enum.text import PP_ALIGN
    prs = Presentation(); prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)
    # 标题页（R4 手法）
    s = prs.slides.add_slide(prs.slide_layouts[6])
    bg = s.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)
    bg.fill.solid(); bg.fill.fore_color.rgb = RGBColor.from_string("1F4E79"); bg.line.fill.background()
    box = s.shapes.add_textbox(Inches(1.2), Inches(2.6), Inches(10.9), Inches(1.4))
    r = box.text_frame.paragraphs[0].add_run(); r.text = "萬星平台年度汇报"
    r.font.size = PPt(40); r.font.bold = True; r.font.color.rgb = RGBColor.from_string("FFFFFF")
    # 内容页：一页一论点
    for title, points in (("经营亮点", ("营收 +38.2%", "NPS 91.5", "生态伙伴 12 家"),),
                          ("明年重点", ("计费闭环", "多租户隔离", "垂直内容深耕"),)):
        s = prs.slides.add_slide(prs.slide_layouts[6])
        tb = s.shapes.add_textbox(Inches(0.9), Inches(0.6), Inches(11.5), Inches(1.0))
        r = tb.text_frame.paragraphs[0].add_run(); r.text = title
        r.font.size = PPt(28); r.font.bold = True; r.font.color.rgb = RGBColor.from_string("1F4E79")
        body = s.shapes.add_textbox(Inches(1.2), Inches(2.0), Inches(10.9), Inches(4.5))
        for i, pt in enumerate(points):
            p = body.text_frame.paragraphs[0] if i == 0 else body.text_frame.add_paragraph()
            r = p.add_run(); r.text = f"· {pt}"
            r.font.size = PPt(20)
    prs.save(path)

build_report_sample(f"{out}/S1-完整报告.docx")
build_workbook_sample(f"{out}/S2-数据工作簿.xlsx")
build_deck_sample(f"{out}/S3-汇报演示.pptx")
print("scenario samples done")
