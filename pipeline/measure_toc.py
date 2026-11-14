# -*- coding: utf-8 -*-
"""量出每个一/二级标题在 PDF 中的页码，写 toc.json 供第二遍排版使用。

页码 = PDF 物理页序（封面为第 1 页），与页脚显示的 PAGE 域一致。
"""
import argparse, json, re, sys

try:
    import pymupdf  # PyMuPDF 新包名
except ImportError:  # 老版本只有 fitz
    import fitz as pymupdf

MIN_SIZE = {"l1": 16.0, "l2": 13.0}


def norm(s):
    return re.sub(r"\s+", "", s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--headings", required=True, help="build_book.py 产出的 .headings.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    heads = json.load(open(args.headings, encoding="utf-8"))
    doc = pymupdf.open(args.pdf)

    # 收集所有"大字号"文本行，按页分组
    pages = []
    for pno in range(doc.page_count):
        rows = []
        for b in doc[pno].get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                txt = "".join(s["text"] for s in ln["spans"]).strip()
                if not txt:
                    continue
                size = max(s["size"] for s in ln["spans"])
                rows.append((norm(txt), size))
        pages.append(rows)

    pages_map = {}
    cursor = 0
    misses = []
    for idx, h in enumerate(heads):
        key = "l1" if h["level"] == 1 else "l2"
        need = MIN_SIZE[key]
        target = norm(h["text"])
        found = None
        for pno in range(cursor, doc.page_count):
            for txt, size in pages[pno]:
                if size < need:
                    continue
                if txt == target or (len(target) > 6 and txt.startswith(target[:8])):
                    found = pno + 1
                    break
            if found:
                cursor = pno
                break
        if found:
            pages_map[str(idx)] = found
        else:
            misses.append(h["text"])

    json.dump(pages_map, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[toc] {len(pages_map)}/{len(heads)} 标题定位成功, pdf {doc.page_count} 页")
    if misses:
        print("[toc] 未定位:", misses[:5], "...", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()
