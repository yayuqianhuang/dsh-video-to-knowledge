# -*- coding: utf-8 -*-
"""DOCX → PDF：只做转换，找不到转换器就跳过（不阻断成书）。

转换器优先级：
  1. 环境变量 VK_PDF_NODE + VK_PDF_CLI（LibreOffice Kit 的 node + cli.js）
  2. 环境变量 VK_SOFFICE / PATH 上的 soffice.exe
  3. 都找不到 → 输出 {"skipped": true} 并退出 0

用法：
  python pipeline/book_pdf.py --in book/pass1.docx --out book/pass1.pdf
"""
import argparse
import io
import json
import os
import shutil
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=1) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def find_kit():
    node = os.environ.get("VK_PDF_NODE")
    cli = os.environ.get("VK_PDF_CLI")
    if node and cli and os.path.isfile(node) and os.path.isfile(cli):
        return ("kit", node, cli)
    return None


def find_soffice():
    cand = os.environ.get("VK_SOFFICE") or shutil.which("soffice") or shutil.which("soffice.exe")
    if cand and os.path.isfile(cand):
        return ("soffice", cand, None)
    for p in (r"C:\Program Files\LibreOffice\program\soffice.exe",
              r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"):
        if os.path.isfile(p):
            return ("soffice", p, None)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        emit({"error": "输入不存在：%s" % args.src, "verdict": "PDF_INPUT_MISSING"}, 2)

    conv = find_kit() or find_soffice()
    if not conv:
        emit({"skipped": True,
              "reason": "找不到 PDF 转换器（VK_PDF_NODE/VK_PDF_CLI 或 soffice）；DOCX 已生成，PDF 跳过",
              "src": args.src, "verdict": "PDF_SKIPPED"})

    os.makedirs(os.path.dirname(os.path.abspath(args.dst)) or ".", exist_ok=True)
    if os.path.isfile(args.dst):
        os.remove(args.dst)

    kind, a, b = conv
    if kind == "kit":
        cmd = [a, b, "convert", "--input", args.src, "--output", args.dst]
    else:
        outdir = os.path.dirname(os.path.abspath(args.dst)) or "."
        cmd = [a, "--headless", "--convert-to", "pdf", "--outdir", outdir, args.src]
    proc = subprocess.run(cmd, capture_output=True)
    ok = os.path.isfile(args.dst) and os.path.getsize(args.dst) > 1000

    if not ok and kind == "soffice":
        # soffice 会按源文件名输出，必要时改名
        auto = os.path.join(os.path.dirname(os.path.abspath(args.dst)),
                            os.path.splitext(os.path.basename(args.src))[0] + ".pdf")
        if os.path.isfile(auto):
            os.replace(auto, args.dst)
            ok = True

    emit({"ok": ok, "converter": kind, "src": args.src, "pdf": args.dst,
          "bytes": os.path.getsize(args.dst) if ok else 0,
          "stderr": (proc.stderr or b"").decode("utf-8", "replace")[-400:] if not ok else "",
          "verdict": "ok" if ok else "PDF_FAILED"},
         0 if ok else 3)


if __name__ == "__main__":
    main()
