# -*- coding: utf-8 -*-
"""通用字幕内容校验（不依赖任何学科词表）。

判定一个分 P 的字幕是否"串台"（时长对得上、内容却是别的视频）：
  1. 标题锚点：把视频总标题 + 该分 P 标题切成 2-4 字词/bigram，统计字幕覆盖率。
  2. 跨分 P 相似度：把每个分 P 的字幕切成 4-gram，用 IDF 加权余弦算它与
     **其余所有分 P** 的相似度中位数。串台分 P 与正常分 P 的相似度会显著低于
     整体中位数；同一支错轨被复制到多个分 P 时，用中位数（而不是最大值/均值）
     可以避免"错误分 P 互相相似"把分数拉高。

两个信号都不达标才判 mismatch；只有一个不达标判 weak（建议人工核对）；
数据不足（没有字幕、分 P 太少、标题无可用词）判 unverified —— 绝不静默判 ok。

用法：
    python pipeline/vk_audit.py --video-id BV1xx --workdir runs
    python pipeline/vk_chain.py audit --video-id BV1xx [--expect "1=词1,词2;2=词3"]
"""

import argparse
import json
import math
import os
import re
import statistics
import sys

CJK = re.compile(r"[\u4e00-\u9fff]+")
ALNUM = re.compile(r"[A-Za-z][A-Za-z0-9_+\-]{1,}")

# 标题里的套话：不承载主题，不能作为"内容对得上"的证据
GENERIC = set("""
课程 教程 视频 教学 全集 完整版 最新 精讲 导学 介绍 篇 第 章 节 讲 部分 更新
自学考试 考试 代码 适用 零基础 入门 实战 全套 小白 大神 干货 废话 资源
""".split())

# 虚词：出现在 bigram 任一侧就丢弃，避免把"的运""与极"当成标题词
STOP_CHARS = set(
    "的了和与及其这那是在有我你他她它就都也很会要把被让对从到而并或等中上下里"
    "个些一不没好更还又再才只们吗呢吧啊呀着过地得"
)
STOP4 = set("我们 你们 他们 这个 那个 这样 那样".split())

NGRAM = 4          # 跨分 P 相似度用的字符 n-gram
TOP_GRAMS = 600    # 每个分 P 最多保留多少个高频 n-gram


def title_terms(*titles):
    """从标题里抽可核对的词：整体短词 + 2-gram；过滤套话与虚词。"""
    terms = set()
    for t in titles:
        t = re.sub(r"【[^】]*】", " ", t or "")
        for run in CJK.findall(t):
            if run in GENERIC:
                continue
            if 2 <= len(run) <= 4:
                terms.add(run)
            for i in range(len(run) - 1):
                bg = run[i:i + 2]
                if bg[0] in STOP_CHARS or bg[1] in STOP_CHARS:
                    continue
                if bg in STOP4:
                    continue
                terms.add(bg)
        for w in ALNUM.findall(t or ""):
            if len(w) >= 2:
                terms.add(w.lower())
    return {x for x in terms if x not in GENERIC and len(x) >= 2}


def ngrams(text, top=TOP_GRAMS, n=NGRAM):
    freq = {}
    for run in CJK.findall(text):
        for i in range(len(run) - n + 1):
            g = run[i:i + n]
            if n == 4 and g in STOP4:
                continue
            if n == 2 and (g in STOP4 or g[0] in STOP_CHARS or g[1] in STOP_CHARS):
                continue
            freq[g] = freq.get(g, 0) + 1
    if len(freq) > top:
        items = sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
        freq = dict(items)
    return freq


def _vectors(freqs, ids):
    df = {}
    for i in ids:
        for g in freqs[i]:
            df[g] = df.get(g, 0) + 1
    n = len(ids)
    idf = {g: math.log((n + 1) / (d + 1)) + 1 for g, d in df.items()}
    vecs = {}
    for i in ids:
        v = {g: (1 + math.log(c)) * idf[g] for g, c in freqs[i].items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs[i] = {g: x / norm for g, x in v.items()}
    return vecs


def _cos(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(g, 0) for g, x in a.items())


def _parse_expect(raw):
    """'1=函数,极限;2=导数,微分' -> {1: ['函数','极限'], 2: ['导数','微分']}"""
    out = {}
    for seg in (raw or "").split(";"):
        if "=" not in seg:
            continue
        k, v = seg.split("=", 1)
        try:
            out[int(k)] = [x.strip() for x in re.split(r"[,，]", v) if x.strip()]
        except ValueError:
            continue
    return out


def audit_texts(parts, texts, video_title="", expect=None, foreign=None):
    """核心算法。parts: [{index,title,durationSec}]；texts: {index: text}。"""
    expect = expect or {}
    foreign = foreign or []
    ids = sorted(texts)
    titles = {p["index"]: (p.get("title") or "") for p in parts}
    anchors = {i: title_terms(video_title, titles.get(i, "")) for i in ids}
    covers = {}
    for i in ids:
        hit = [t for t in anchors[i] if t in (texts.get(i) or "")]
        covers[i] = len(hit) / max(1, len(anchors[i])) if anchors[i] else 0.0
    cover_med = statistics.median(list(covers.values())) if covers else 0.0

    freqs = {i: ngrams(texts[i]) for i in ids}
    vecs = _vectors(freqs, ids) if len(ids) > 1 else {i: {} for i in ids}
    peer_med = {}
    for i in ids:
        vals = [_cos(vecs[i], vecs[j]) for j in ids if j != i]
        peer_med[i] = statistics.median(vals) if vals else 0.0
    all_med = statistics.median(list(peer_med.values())) if peer_med else 0.0

    # 短字幕/章节差异极大时，4-gram 可能完全无交集（median=0，比值失效）；
    # 退到 2-gram 再算一次，至少能拿到"是否共享同一套主题词"的信号。
    if len(ids) > 1 and all_med < 0.005:
        freqs = {i: ngrams(texts[i], n=2) for i in ids}
        vecs = _vectors(freqs, ids)
        peer_med = {}
        for i in ids:
            vals = [_cos(vecs[i], vecs[j]) for j in ids if j != i]
            peer_med[i] = statistics.median(vals) if vals else 0.0
        all_med = statistics.median(list(peer_med.values())) if peer_med else 0.0

    rows = []
    for p in sorted(parts, key=lambda x: x["index"]):
        i = p["index"]
        text = texts.get(i, "") or ""
        chars = len(text)
        cover = covers.get(i, 0.0)
        hit = [t for t in anchors.get(i, set()) if t in text]
        ratio = (peer_med[i] / all_med) if all_med > 1e-9 else 1.0
        fw = [w for w in foreign if w and w in text]
        exp = expect.get(i)

        if chars < 50:
            verdict = "empty"
        elif exp:
            hits = [k for k in exp if k in text]
            verdict = ("ok" if len(hits) >= min(2, len(exp))
                       else ("weak" if hits else "mismatch"))
            cover = len(hits) / max(1, len(exp))
            hit = hits
        elif not anchors.get(i):
            verdict = "unverified"
        elif len(ids) < 3:
            verdict = "ok" if cover >= 0.10 else "unverified"
        elif chars < 1500:
            # 短分 P（花絮/预告/收尾）字太少，相似度比值噪声大；只按标题锚点判
            verdict = "ok" if cover >= 0.06 else "unverified"
        elif all_med < 1e-9:
            # 分 P 之间没有任何共享词：只能靠标题锚点相对值判断
            if cover < 0.06 and cover_med >= 0.10:
                verdict = "mismatch"
            elif cover < 0.06:
                verdict = "weak"
            else:
                verdict = "ok"
        elif ratio < 0.45 and cover < 0.08:
            verdict = "mismatch"      # 与其余分 P 明显不同，且标题词几乎不命中
        elif ratio < 0.30 and cover < 0.15:
            verdict = "mismatch"      # 极端离群，即使偶然命中一两个标题词也可疑
        elif ratio < 0.65 and cover < 0.06:
            verdict = "mismatch"
        elif ratio < 0.55 and cover < 0.12:
            verdict = "weak"
        elif fw and ratio < 0.75:
            verdict = "mismatch"      # 人工传入的异物词只作为辅助证据
        else:
            verdict = "ok"

        rows.append({
            "p": i, "chars": chars,
            "titleCover": round(cover, 3), "titleHits": hit[:8],
            "peer": round(peer_med[i], 4), "peerRatio": round(ratio, 2),
            "foreign": fw, "verdict": verdict,
        })

    mismatched = [r["p"] for r in rows if r["verdict"] in ("mismatch", "empty")]
    weak = [r["p"] for r in rows if r["verdict"] == "weak"]
    unverified = [r["p"] for r in rows if r["verdict"] == "unverified"]
    empty = [r["p"] for r in rows if r["verdict"] == "empty"]

    if mismatched:
        reason = "有分 P 字幕为空" if empty and not [r for r in rows if r["verdict"] == "mismatch"] \
            else "疑似字幕串台"
        verdict = "mismatch"
        warning = "本批字幕%s（分 P：%s），建议先修字幕再写卡片" % (
            reason, ",".join(str(x) for x in mismatched))
    elif weak or unverified:
        verdict = "review"
        warning = "本批字幕未通过完整内容校验，建议人工核对分 P 是否串台"
        if weak:
            warning += "（复核：%s）" % ",".join(str(x) for x in weak)
        if unverified:
            warning += "（无法判定：%s）" % ",".join(str(x) for x in unverified)
    else:
        verdict = "ok"
        warning = ""

    return rows, {
        "ok": verdict == "ok",
        "verdict": verdict,
        "warning": warning,
        "mismatched": mismatched,
        "weak": weak,
        "unverified": unverified,
        "empty": empty,
        "medianPeer": round(all_med, 4),
        "parts": rows,
    }


def _texts_from_transcript(viddir, meta):
    rel = os.path.join(viddir, "transcript.jsonl")
    if not os.path.isfile(rel):
        return {}
    recs = []
    with open(rel, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.strip():
                try:
                    recs.append(json.loads(line))
                except ValueError:
                    continue
    out = {}
    for p in meta.get("parts") or []:
        off = p.get("offsetSec") or 0
        end = off + (p.get("durationSec") or 0)
        segs = [r for r in recs if off <= r.get("startSec", 0) < end]
        out[p["index"]] = "\n".join(r.get("text") or "" for r in segs)
    return out


def load_part_texts(viddir, meta, prefer_transcript=False):
    """优先用 by_p（已清洗）；没有则从 transcript.jsonl 按分 P 偏移切。

    ASR 重转后 by_p 还是旧的（要等 build 才刷新），此时 transcript.jsonl 更新；
    用 mtime 判断，避免拿旧素材把刚修好的分 P 又判成串台。by_p 只覆盖一部分时，
    缺的分 P 再从 transcript 补齐。
    """
    texts = {}
    byp = os.path.join(viddir, "by_p")
    tpath = os.path.join(viddir, "transcript.jsonl")
    use_by_p = (not prefer_transcript) and os.path.isdir(byp)
    if use_by_p and os.path.isfile(tpath):
        try:
            names = [n for n in os.listdir(byp) if n.endswith(".txt")]
            newest_byp = max(os.path.getmtime(os.path.join(byp, n)) for n in names) if names else 0
            if os.path.getmtime(tpath) > newest_byp + 0.5:
                use_by_p = False
        except OSError:
            pass

    if use_by_p:
        for name in sorted(os.listdir(byp)):
            m = re.match(r"^p(\d{2})\.txt$", name)
            if m:
                with open(os.path.join(byp, name), encoding="utf-8", errors="replace") as fh:
                    texts[int(m.group(1))] = fh.read()

    if not texts or len(texts) < len(meta.get("parts") or []):
        for idx, txt in _texts_from_transcript(viddir, meta).items():
            texts.setdefault(idx, txt)
    return texts


def audit_run(viddir, meta=None, expect=None, foreign=None, prefer_transcript=False):
    """从落盘产物直接审计一个 run，返回 summary（含 parts 明细）。"""
    if meta is None:
        meta_path = os.path.join(viddir, "meta.json")
        try:
            with open(meta_path, encoding="utf-8-sig") as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            meta = {}
    parts = meta.get("parts") or []
    video_title = meta.get("title") or ""
    if not parts:
        return {"ok": False, "verdict": "unverified",
                "warning": "缺少 meta.json 或分 P 信息，无法做内容校验",
                "mismatched": [], "weak": [], "unverified": [], "empty": [], "parts": []}

    texts = load_part_texts(viddir, meta, prefer_transcript=prefer_transcript)
    if not texts:
        return {"ok": False, "verdict": "unverified",
                "warning": "没有字幕文本（by_p/ 与 transcript.jsonl 都为空），无法做内容校验",
                "mismatched": [], "weak": [], "unverified": [p["index"] for p in parts],
                "empty": [], "parts": []}

    missing = [p["index"] for p in parts if p["index"] not in texts]
    if missing:
        texts.update({i: "" for i in missing})
    _, summary = audit_texts(parts, texts, video_title,
                             expect=expect, foreign=foreign)
    summary["videoId"] = meta.get("videoId") or os.path.basename(viddir.rstrip("/\\"))
    summary["mode"] = "expect" if expect else "title+peer"
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description="通用字幕内容校验（防串台）")
    ap.add_argument("--video-id", required=True)
    ap.add_argument("--workdir", default="runs")
    ap.add_argument("--expect", default="",
                    help='手工关键词，形如 "1=函数,极限;2=导数,微分"')
    ap.add_argument("--foreign-words", default="",
                    help="可选：异物词，逗号分隔；仅作为辅助证据")
    a = ap.parse_args(argv)
    vdir = os.path.join(a.workdir, a.video_id)
    expect = _parse_expect(a.expect)
    foreign = [x.strip() for x in re.split(r"[,，]", a.foreign_words) if x.strip()]
    summary = audit_run(vdir, expect=expect, foreign=foreign)
    sys.stdout.write(json.dumps(summary, ensure_ascii=False, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
