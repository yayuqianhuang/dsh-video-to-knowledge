#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
clean_transcript.py — 视频字幕脚本清洗 + 脱敏 + 切块

被 chains/video-to-knowledge/gen.video-to-knowledge.prepare.json 的
cleanTranscript 节点调用（agentStep 执行）：

    python scripts/clean_transcript.py \
        --input  runs/<videoId>/transcript.jsonl \
        --output runs/<videoId>/clean.jsonl \
        --stats  runs/<videoId>/clean.stats.json

输入 transcript.jsonl 每行：{"idx":int,"startSec":int,"endSec":int,"text":str}
输出：
  - clean.jsonl        ：清洗后逐段 {idx,startSec,endSec,text}，时间戳原样保留且单调
  - clean.stats.json   ：{piiHits, fillerHits, dedupCount, mergedCount, chars, chunkCount, chunks[]}
  - runs/<videoId>/chunks/chunk-<n>.jsonl ：每块所属原始段表（供 chunk 子链时间戳白名单）
  - stdout             ：打印 $.clean 的 JSON（chars/cleanPath/statsPath/chunks[]），供链读取

设计约束（来自 SDD FR-05 / AC-05.x）：
  - 时间戳只来自原始字幕，永不重排、不生成；仅清洗 text。
  - 清洗后总字数 < 300 → 退出码 2（TRANSCRIPT_TOO_SHORT），不产出空卡片。
  - PII（手机/身份证/邮箱/银行卡）正则替换为 [已脱敏]，命中数记 piiHits。
  - 按 ~3000 字切块，chunks[] 每项含 chunkIndex/charCount/segmentsPath。
"""

import argparse
import json
import os
import re
import sys

# ---- 口癖/填充词表（去口语化，仅统计命中、剥离独立填充词，不破坏实义）----
FILLER_WORDS = [
    "嗯", "呃", "那个", "这个", "就是", "然后", "其实", "可能", "的话",
    "对吧", "是吧", "啊", "呀", "嘛", "呢", "就是说", "所以说", "那么",
]
# 独立成词（前后非中文/数字）才剥离，避免误删"那个"作为代词的语义
_FILLER_RE = re.compile(
    r"(?<=[\s,，。.！!？?；;：:、])(" + "|".join(re.escape(w) for w in FILLER_WORDS) + r")(?=[\s,，。.！!？?；;：:、]|$)"
)

# ---- PII 正则 ----
RE_PHONE = re.compile(r"1[3-9]\d{9}")
RE_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
RE_BANK = re.compile(r"(?<!\d)(?:\d[ \-]?){15,18}(?!\d)")  # 15-18 位连续数字（银行卡近似）
RE_IDCARD = re.compile(r"(?<!\d)\d{17}[\dXx]|\d{15}(?!\d)")  # 身份证 18/15 位

CHUNK_SIZE = 3000
MIN_CHARS = 300
MIN_SEG_CHARS = 4  # 单段 < 4 字合并到相邻段


def strip_filler(text):
    """剥离独立填充词，返回 (清洗后文本, 命中数)。"""
    hits = 0
    prev = None
    out_parts = []
    for m in _FILLER_RE.finditer(text):
        pass
    # 统计命中次数（用 findall 近似：每个独立填充词一次）
    hits = len(_FILLER_RE.findall(text))
    cleaned = _FILLER_RE.sub("", text)
    # 折叠因剥离产生的多余空格
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned, hits


def mask_pii(text):
    """PII 替换为 [已脱敏]，返回 (文本, 命中数)。"""
    hits = 0
    for rx in (RE_PHONE, RE_EMAIL, RE_BANK, RE_IDCARD):
        found = rx.findall(text)
        if found:
            hits += len(found)
            text = rx.sub("[已脱敏]", text)
    return text, hits


def load_segments(path):
    segs = []
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            segs.append(obj)
    # 时间戳原样保留，仅按 startSec 单调排序防乱序（不重排内容语义）
    segs.sort(key=lambda s: (s.get("startSec", 0), s.get("idx", 0)))
    return segs


def clean_segments(segs):
    """返回 (cleaned_segs, stats)。"""
    filler_hits = 0
    pii_hits = 0
    dedup_count = 0
    merged_count = 0

    cleaned = []
    prev_text = None
    pending_merge = None  # 待合并的短段

    for s in segs:
        text = s.get("text", "") or ""
        # PII 脱敏
        text, h = mask_pii(text)
        pii_hits += h
        # 去口癖
        text, fh = strip_filler(text)
        filler_hits += fh

        text = text.strip()
        if not text:
            continue
        # 连续重复句去重
        if text == prev_text:
            dedup_count += 1
            continue
        prev_text = text

        # 单段 < 4 字合并到相邻段（保留本段时间戳范围）
        if len(text) < MIN_SEG_CHARS:
            if pending_merge is not None:
                pending_merge["text"] = (pending_merge["text"] + text).strip()
                pending_merge["endSec"] = s.get("endSec", pending_merge["endSec"])
                merged_count += 1
                continue
            elif cleaned:
                cleaned[-1]["text"] = (cleaned[-1]["text"] + text).strip()
                cleaned[-1]["endSec"] = s.get("endSec", cleaned[-1]["endSec"])
                merged_count += 1
                continue
            # 首段就太短且无法前并：保留但标记（避免丢信息）
        pending_merge = None

        item = {
            "idx": s.get("idx"),
            "startSec": s.get("startSec"),
            "endSec": s.get("endSec"),
            "text": text,
        }
        cleaned.append(item)
        pending_merge = item if len(text) < MIN_SEG_CHARS else None

    stats = {
        "fillerHits": filler_hits,
        "piiHits": pii_hits,
        "dedupCount": dedup_count,
        "mergedCount": merged_count,
    }
    return cleaned, stats


def chunk_segments(cleaned, video_id, runs_dir):
    """按 ~3000 字切块，写每块段表，返回 chunks[]。"""
    chunks = []
    cur = []
    cur_chars = 0
    n = 0
    chunk_dir = os.path.join(runs_dir, video_id, "chunks")
    os.makedirs(chunk_dir, exist_ok=True)

    for s in cleaned:
        seg_chars = len(s["text"])
        if cur and cur_chars + seg_chars > CHUNK_SIZE:
            chunks.append(_flush_chunk(cur, n, chunk_dir))
            n += 1
            cur = []
            cur_chars = 0
        cur.append(s)
        cur_chars += seg_chars

    if cur:
        chunks.append(_flush_chunk(cur, n, chunk_dir))
        n += 1
    return chunks


def _flush_chunk(seg_list, index, chunk_dir):
    path = os.path.join(chunk_dir, f"chunk-{index:02d}.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        for s in seg_list:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    return {
        "chunkIndex": index,
        "charCount": sum(len(s["text"]) for s in seg_list),
        "segmentsPath": path,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--stats", required=True)
    args = ap.parse_args()

    # videoId 从 input 路径推导：runs/<videoId>/transcript.jsonl
    m = re.search(r"runs[\\/]([^\\/]+)[\\/]", os.path.normpath(args.input))
    video_id = m.group(1) if m else "unknown"
    runs_dir = os.path.join(os.getcwd(), "runs")

    segs = load_segments(args.input)
    cleaned, stats = clean_segments(segs)
    total_chars = sum(len(s["text"]) for s in cleaned)

    # 清洗后总字数 < 300 → 早停
    if total_chars < MIN_CHARS:
        result = {
            "aborted": True,
            "reason": "TRANSCRIPT_TOO_SHORT",
            "chars": total_chars,
        }
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(2)

    # 落盘 clean.jsonl
    out_dir = os.path.dirname(args.output)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        for s in cleaned:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    chunks = chunk_segments(cleaned, video_id, runs_dir)

    stats.update({
        "chars": total_chars,
        "segmentCount": len(cleaned),
        "chunkCount": len(chunks),
    })

    # 写 stats.json
    stats_dir = os.path.dirname(args.stats)
    if stats_dir:
        os.makedirs(stats_dir, exist_ok=True)
    with open(args.stats, "w", encoding="utf-8") as f:
        json.dump(stats, ensure_ascii=False, indent=2, fp=f)

    # 打印 $.clean（供链读取）
    result = {
        "chars": total_chars,
        "cleanPath": os.path.abspath(args.output),
        "statsPath": os.path.abspath(args.stats),
        "chunks": chunks,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
