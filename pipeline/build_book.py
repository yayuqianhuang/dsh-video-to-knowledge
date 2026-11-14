# -*- coding: utf-8 -*-
"""把 book/book.md 编译成排版好的 DOCX。

用法:
  python build_book.py --md book/book.md --out book/xxx.docx [--toc book/toc.json]

两遍排版：
  第 1 遍 toc.json 不存在 → 目录用占位行（行数与真实条目一致，保证分页不变）
  转 PDF 后用 measure_toc.py 量出每个标题所在页，写 toc.json
  第 2 遍带上 toc.json → 目录填入真实页码，分页与第 1 遍一致
"""
import argparse, json, os, re, sys

# python-docx 是可选依赖：缺失时给出可执行的安装提示，而不是栈回溯
try:
    from docx import Document
except ImportError:  # pragma: no cover
    sys.stderr.write(json.dumps({
        "error": "缺少 python-docx，无法排版 DOCX",
        "hint": "pip install python-docx；或用 DSH 内置 runtime 的 python 运行（自带 python-docx）",
        "verdict": "BOOK_DEPS_MISSING",
    }, ensure_ascii=False) + "\n")
    sys.exit(9)
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

SONG = "宋体"
HEI = "黑体"
KAI = "楷体"
LATIN = "Times New Roman"
ACCENT = RGBColor(0x8C, 0x1D, 0x18)   # 深红，取自"近代史"气质
GREY = RGBColor(0x55, 0x55, 0x55)


# ----------------------------------------------------------------- 基础工具
def set_font(run, name=SONG, size=10.5, bold=None, color=None, italic=None):
    run.font.name = LATIN if name == LATIN else name
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.append(rFonts)
    rFonts.set(qn("w:ascii"), LATIN if name == LATIN else name)
    rFonts.set(qn("w:hAnsi"), LATIN if name == LATIN else name)
    rFonts.set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    if color is not None:
        run.font.color.rgb = color


def para_format(p, before=0, after=0, line=1.35, first_indent=None,
                left=None, right=None, align=None, keep_next=False):
    pf = p.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line
    if first_indent is not None:
        pf.first_line_indent = Cm(first_indent)
    if left is not None:
        pf.left_indent = Cm(left)
    if right is not None:
        pf.right_indent = Cm(right)
    if align is not None:
        p.alignment = align
    if keep_next:
        pf.keep_with_next = True


def add_bottom_border(p, sz=6, color="8C1D18"):
    pPr = p._p.get_or_add_pPr()
    pbdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(sz))
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), color)
    pbdr.append(bottom)
    pPr.append(pbdr)


def add_field(paragraph, instr, placeholder=""):
    run = paragraph.add_run()
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), instr)
    t = OxmlElement("w:t")
    t.text = placeholder
    r = OxmlElement("w:r")
    r.append(t)
    fld.append(r)
    paragraph._p.append(fld)


INLINE_RE = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\[[0-9]{1,3}:[0-9]{2}\]|【[^】]{1,20}】)")


def add_inline(p, text, name=SONG, size=10.5, color=None, bold=False):
    """支持 **粗体**、`代码`、时间码 [12:34] 高亮。"""
    for part in INLINE_RE.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            r = p.add_run(part[2:-2])
            set_font(r, name, size, bold=True, color=color)
        elif part.startswith("`") and part.endswith("`"):
            r = p.add_run(part[1:-1])
            set_font(r, SONG, size, color=color, bold=bold)
            r.font.color.rgb = RGBColor(0x8C, 0x1D, 0x18)
        elif re.fullmatch(r"\[[0-9]{1,3}:[0-9]{2}\]", part):
            r = p.add_run(part)
            set_font(r, LATIN, size - 1, color=RGBColor(0x7A, 0x7A, 0x7A))
        else:
            r = p.add_run(part)
            set_font(r, name, size, bold=bold, color=color)


def shade(cell, hexcolor):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hexcolor)
    tcPr.append(shd)


def set_cell_margins(table, top=60, bottom=60, left=100, right=100):
    tblPr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for tag, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement(f"w:{tag}")
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tblPr.append(mar)


def set_grid(table, widths_cm):
    """真正决定列宽的不是 cell.width，而是 tblGrid/gridCol。"""
    tbl = table._tbl
    grid = tbl.find(qn("w:tblGrid"))
    if grid is None:
        grid = OxmlElement("w:tblGrid")
        tbl.tblPr.addnext(grid)
    for gc in list(grid.findall(qn("w:gridCol"))):
        grid.remove(gc)
    for w in widths_cm:
        gc = OxmlElement("w:gridCol")
        gc.set(qn("w:w"), str(int(round(w * 567))))
        grid.append(gc)
    tblPr = tbl.tblPr
    for old in tblPr.findall(qn("w:tblW")):
        tblPr.remove(old)
    tblW = OxmlElement("w:tblW")
    tblW.set(qn("w:w"), str(int(round(sum(widths_cm) * 567))))
    tblW.set(qn("w:type"), "dxa")
    tblPr.append(tblW)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tblPr.append(layout)


def repeat_header(row):
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    trPr.append(el)


def cant_split(row):
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:cantSplit")
    el.set(qn("w:val"), "true")
    trPr.append(el)


# ----------------------------------------------------------------- 解析
def parse_md(path):
    blocks = []
    lines = open(path, encoding="utf-8-sig").read().replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            i += 1
            continue
        # 指令行
        if s.startswith("%%"):
            tag, _, rest = s[2:].partition(" ")
            blocks.append(("directive", tag.strip().lower(), rest.strip()))
            i += 1
            continue
        # 表格
        if s.startswith("|") and s.endswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                raw = lines[i].strip().strip("|")
                cells = [c.strip() for c in raw.split("|")]
                if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                    rows.append(cells)
                i += 1
            blocks.append(("table", rows))
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", s)
        if m:
            blocks.append(("h", len(m.group(1)), m.group(2).strip()))
            i += 1
            continue
        if s.startswith("> "):
            buf = []
            while i < len(lines) and lines[i].strip().startswith("> "):
                buf.append(lines[i].strip()[2:].strip())
                i += 1
            blocks.append(("quote", " ".join(buf)))
            continue
        if re.match(r"^[-*]\s+", s):
            items = []
            while i < len(lines) and re.match(r"^[-*]\s+", lines[i].strip()):
                items.append(re.sub(r"^[-*]\s+", "", lines[i].strip()))
                i += 1
            blocks.append(("ul", items))
            continue
        if re.match(r"^\d+\.\s+", s):
            items = []
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i].strip()):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i].strip()))
                i += 1
            blocks.append(("ol", items))
            continue
        blocks.append(("p", s))
        i += 1
    return blocks


# ----------------------------------------------------------------- 渲染
class Book:
    def __init__(self):
        self.doc = Document()
        self.headings = []          # [(level, text)]
        self._setup_styles()
        self._setup_page()

    def _setup_styles(self):
        st = self.doc.styles["Normal"]
        st.font.name = LATIN
        st.font.size = Pt(10.5)
        st.element.rPr.rFonts.set(qn("w:eastAsia"), SONG)
        st.paragraph_format.line_spacing = 1.35

    def _setup_page(self):
        sec = self.doc.sections[0]
        sec.page_width = Cm(17.6)
        sec.page_height = Cm(25.0)
        sec.top_margin = Cm(2.2)
        sec.bottom_margin = Cm(2.1)
        sec.left_margin = Cm(2.3)
        sec.right_margin = Cm(2.1)
        sec.header_distance = Cm(1.2)
        sec.footer_distance = Cm(1.2)

    # ---------------- 页眉页脚
    def enable_header_footer(self):
        sec = self.doc.sections[0]
        sec.different_first_page_header_footer = True   # 封面不显示页眉页码
        hp = sec.header.paragraphs[0]
        hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        add_bottom_border(hp, sz=4, color="BBBBBB")
        r = hp.add_run("中国近现代史纲要 · 全书考点参考书")
        set_font(r, SONG, 9, color=GREY)

        fp = sec.footer.paragraphs[0]
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r1 = fp.add_run("· ")
        set_font(r1, SONG, 9, color=GREY)
        add_field(fp, "PAGE", "1")
        r2 = fp.add_run(" ·")
        set_font(r2, SONG, 9, color=GREY)

    # ---------------- 标题页
    def title_page(self, title, subtitle, lines):
        for _ in range(5):
            p = self.doc.add_paragraph()
            para_format(p, after=0, line=1.0)
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        para_format(p, after=2, line=1.15)
        r = p.add_run(title)
        set_font(r, HEI, 30, bold=True, color=ACCENT)

        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        para_format(p, before=10, after=10)
        r = p.add_run("—" * 16)
        set_font(r, SONG, 10, color=ACCENT)

        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        para_format(p, before=4, after=4, line=1.3)
        r = p.add_run(subtitle)
        set_font(r, HEI, 19, bold=False, color=RGBColor(0x33, 0x33, 0x33))

        for _ in range(5):
            p = self.doc.add_paragraph()
            para_format(p, after=0, line=1.0)

        for ln in lines:
            p = self.doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            para_format(p, before=2, after=2, line=1.2)
            add_inline(p, ln, SONG, 10, color=RGBColor(0x44, 0x44, 0x44))

        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        para_format(p, before=22, after=2)
        r = p.add_run("二〇二六年十一月")
        set_font(r, SONG, 10.5, color=RGBColor(0x44, 0x44, 0x44))

    def page_break(self):
        from docx.enum.text import WD_BREAK
        p = self.doc.add_paragraph()
        para_format(p, after=0, line=1.0)
        r = p.add_run()
        set_font(r, SONG, 1)
        r.add_break(WD_BREAK.PAGE)

    # ---------------- 目录
    def toc(self, entries, pages=None):
        p = self.doc.add_paragraph()
        para_format(p, before=0, after=10, align=WD_ALIGN_PARAGRAPH.CENTER)
        r = p.add_run("目　　录")
        set_font(r, HEI, 20, bold=True, color=ACCENT)
        add_bottom_border(p, sz=8)

        p = self.doc.add_paragraph()
        para_format(p, before=2, after=8, align=WD_ALIGN_PARAGRAPH.CENTER)
        r = p.add_run("（页码对应本书 PDF 版）")
        set_font(r, SONG, 8.5, color=GREY)

        for idx, (level, text) in enumerate(entries):
            p = self.doc.add_paragraph()
            para_format(p, before=2 if level == 1 else 0, after=2 if level == 1 else 0,
                        line=1.25, left=(0 if level == 1 else 0.7))
            pf = p.paragraph_format
            pf.tab_stops.add_tab_stop(Cm(12.6), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
            if level == 1:
                r = p.add_run(text)
                set_font(r, HEI, 11, bold=True)
            else:
                r = p.add_run(text)
                set_font(r, SONG, 10.5)
            num = ""
            if pages and str(idx) in pages:
                num = str(pages[str(idx)])
            r2 = p.add_run("\t" + (num or " "))
            set_font(r2, SONG, 10.5)

    # ---------------- 正文块
    def heading(self, level, text):
        self.headings.append((level, text))
        p = self.doc.add_paragraph()
        if level == 1:
            para_format(p, before=6, after=14, line=1.2, keep_next=True)
            r = p.add_run(text)
            set_font(r, HEI, 19, bold=True, color=ACCENT)
            add_bottom_border(p, sz=10)
        elif level == 2:
            para_format(p, before=16, after=8, line=1.25, keep_next=True)
            r = p.add_run(text)
            set_font(r, HEI, 14.5, bold=True, color=RGBColor(0x22, 0x22, 0x22))
        elif level == 3:
            para_format(p, before=11, after=5, line=1.25, keep_next=True)
            r = p.add_run(text)
            set_font(r, HEI, 11.5, bold=True, color=ACCENT)
        else:
            para_format(p, before=8, after=4, line=1.25, keep_next=True)
            r = p.add_run(text)
            set_font(r, HEI, 10.5, bold=True)
        p.style = self.doc.styles["Normal"]

    def para(self, text, indent=0.74, size=10.5, name=SONG, after=3):
        p = self.doc.add_paragraph()
        para_format(p, after=after, first_indent=indent, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
        add_inline(p, text, name, size)
        return p

    def bullets(self, items, numbered=False):
        for n, it in enumerate(items, 1):
            p = self.doc.add_paragraph()
            para_format(p, before=1, after=1, line=1.32, left=0.9, first_indent=-0.55)
            mark = f"{n}. " if numbered else "· "
            r = p.add_run(mark)
            set_font(r, SONG, 10.5, bold=True, color=ACCENT if not numbered else None)
            add_inline(p, it, SONG, 10.5)

    def quote(self, text):
        p = self.doc.add_paragraph()
        para_format(p, before=4, after=6, line=1.3, left=0.8, right=0.6)
        pf = p._p.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        left = OxmlElement("w:left")
        left.set(qn("w:val"), "single")
        left.set(qn("w:sz"), "12")
        left.set(qn("w:space"), "6")
        left.set(qn("w:color"), "8C1D18")
        pbdr.append(left)
        pf.append(pbdr)
        add_inline(p, text, KAI, 10, color=RGBColor(0x40, 0x40, 0x40))

    def table(self, rows, caption=None, cols=None):
        ncol = max(len(r) for r in rows)
        if caption:
            p = self.doc.add_paragraph()
            para_format(p, before=6, after=2, line=1.15, keep_next=True)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(caption)
            set_font(r, HEI, 9, color=RGBColor(0x66, 0x66, 0x66))
        t = self.doc.add_table(rows=0, cols=ncol)
        t.style = "Table Grid"
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        t.autofit = False
        set_cell_margins(t)

        # 按"显示宽度"分配列宽：中日韩字符按 2 计，避免中文列被压得过窄
        def disp(s):
            return sum(2 if ord(c) > 0x2E80 else 1 for c in s)

        weights = []
        for ci in range(ncol):
            longest = max((disp(r[ci]) if ci < len(r) else 0) for r in rows)
            weights.append(min(max(longest, 6), 46))
        if cols and len(cols) == ncol:
            weights = list(cols)
        total_w = float(sum(weights))
        avail = 13.2
        widths = [max(avail * w / total_w, 1.5) for w in weights]
        scale = avail / sum(widths)
        widths = [w * scale for w in widths]
        set_grid(t, widths)

        for ri, row in enumerate(rows):
            cells = t.add_row().cells
            cant_split(t.rows[-1])
            for ci in range(ncol):
                txt = row[ci] if ci < len(row) else ""
                cell = cells[ci]
                cell.width = Cm(widths[ci])
                cell.text = ""
                p = cell.paragraphs[0]
                para_format(p, before=1, after=1, line=1.15)
                if ri == 0:
                    shade(cell, "F2E6E5")
                    r = p.add_run(txt)
                    set_font(r, HEI, 9.5, bold=True)
                else:
                    add_inline(p, txt, SONG, 9.5)
        if rows:
            repeat_header(t.rows[0])
        p = self.doc.add_paragraph()
        para_format(p, before=0, after=4, line=1.0)
        return t

    def render(self, blocks, toc_entries=None, pages=None, skip_title=False):
        title = sub = None
        title_lines = []
        pending_caption = None
        pending_cols = None
        first_h1_done = False
        for b in blocks:
            kind = b[0]
            if kind == "directive":
                tag, val = b[1], b[2]
                if tag == "title":
                    title = val
                elif tag == "subtitle":
                    sub = val
                elif tag == "caption":
                    pending_caption = val
                elif tag == "cols":
                    try:
                        pending_cols = [float(x) for x in val.split(",")]
                    except ValueError:
                        pending_cols = None
                elif tag == "toc":
                    self.enable_header_footer()
                    self.page_break()
                    self.toc(toc_entries or [], pages)
                    self.page_break()
                elif tag == "pagebreak":
                    self.page_break()
            elif kind == "h":
                if b[1] == 1:
                    if first_h1_done:
                        self.page_break()
                    first_h1_done = True
                self.heading(b[1], b[2])
            elif kind == "p":
                self.para(b[1])
            elif kind == "ul":
                self.bullets(b[1])
            elif kind == "ol":
                self.bullets(b[1], numbered=True)
            elif kind == "quote":
                self.quote(b[1])
            elif kind == "table":
                self.table(b[1], caption=pending_caption, cols=pending_cols)
                pending_caption = None
                pending_cols = None
        return self


def collect_headings(blocks):
    out = []
    for b in blocks:
        if b[0] == "h" and b[1] <= 2:
            out.append((b[1], b[2]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", required=True, action="append",
                    help="可重复：按给定顺序拼接多个 Markdown")
    ap.add_argument("--out", required=True)
    ap.add_argument("--toc")
    ap.add_argument("--title", default="")
    args = ap.parse_args()

    blocks = []
    for path in args.md:
        blocks.extend(parse_md(path))
    title = next((b[2] for b in blocks if b[0] == "directive" and b[1] == "title"), "")
    sub = next((b[2] for b in blocks if b[0] == "directive" and b[1] == "subtitle"), "")
    lines = [b[2] for b in blocks if b[0] == "directive" and b[1] == "cover"]

    pages = None
    if args.toc and os.path.isfile(args.toc):
        pages = json.load(open(args.toc, encoding="utf-8"))

    entries = collect_headings(blocks)
    bk = Book()
    bk.title_page(title, sub, lines)
    bk.render(blocks, toc_entries=entries, pages=pages)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    bk.doc.save(args.out)
    json.dump([{"level": l, "text": t} for l, t in entries],
              open(args.out + ".headings.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"[book] saved {args.out} · headings={len(entries)} · toc_pages={bool(pages)}")


if __name__ == "__main__":
    main()
