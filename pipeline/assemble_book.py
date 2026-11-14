# -*- coding: utf-8 -*-
"""把「简介 + 各编 + 各附录」拼成一册 Markdown，供 build_book.py 排版。

目录约定（--book-dir 下）：
  front.md            简介（可选）
  parts/partNN.md     各编，按编号排序（part01、part02…）
  parts/appX.md       附录，按 A→G 顺序
  book_all.md         产物

用法：
  python pipeline/assemble_book.py --book-dir book --out book/book_all.md
"""
import argparse
import glob
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
APP_ORDER = ["appA", "appB", "appC", "appD", "appE", "appF", "appG"]


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=1) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def part_no(name):
    return int(re.search(r"part(\d+)", name).group(1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book-dir", default="book")
    ap.add_argument("--out", default="")
    ap.add_argument("--strict", action="store_true",
                    help="缺 front.md 或没有任何 partNN.md 时报错")
    args = ap.parse_args()

    root = os.path.abspath(args.book_dir)
    parts_dir = os.path.join(root, "parts")
    out = args.out or os.path.join(root, "book_all.md")

    files, missing = [], []
    front = os.path.join(root, "front.md")
    if os.path.isfile(front):
        files.append(front)
    elif args.strict:
        emit({"error": "缺 front.md", "verdict": "BOOK_SRC_MISSING"}, 2)

    parts = sorted(glob.glob(os.path.join(parts_dir, "part*.md")), key=part_no)
    if not parts and args.strict:
        emit({"error": "%s 下没有 partNN.md" % parts_dir, "verdict": "BOOK_SRC_MISSING"}, 2)
    files += parts

    for app in APP_ORDER:
        p = os.path.join(parts_dir, app + ".md")
        if os.path.isfile(p):
            files.append(p)
        else:
            missing.append(app)

    if not files:
        emit({"error": "没有任何可拼接的源文件", "verdict": "BOOK_SRC_MISSING"}, 2)

    chunks = [io.open(f, encoding="utf-8-sig").read().rstrip() + "\n" for f in files]
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    io.open(out, "w", encoding="utf-8", newline="\n").write("\n".join(chunks))

    text = "".join(chunks)
    emit({"bookDir": root, "out": out, "files": [os.path.basename(f) for f in files],
          "missingApps": missing,
          "chars": len(re.sub(r"\s+", "", text)),
          "cjk": len(re.findall(r"[\u4e00-\u9fa5]", text)),
          "verdict": "ok"})


if __name__ == "__main__":
    main()
