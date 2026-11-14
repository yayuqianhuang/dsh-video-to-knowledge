# -*- coding: utf-8 -*-
"""信号节点的确定性内核：字幕内容校验 / 多轮字幕探测 / 本地 ASR 兜底。

这三个命令对应三轮实战踩出来的三个坑：
  1. audit  —— 平台字幕可能"时长对得上、内容却是别的视频"（串台），
               只比时长拦不住，必须做内容级关键词命中校验。
  2. probe  —— B 站 x/player/v2 的返回不稳定：同一分 P 时而有时而无、
               时而返回别处的字幕；单次探测不可信，要多轮采样再按时长择优。
  3. asr    —— 没有可用字幕时的兜底转写；faster-whisper 的 PyAV 解码在
               某些版本组合下会 TypeError，所以统一用 ffmpeg 解码成 numpy。

每个命令都只输出一个 JSON 到 stdout，退出码即信号：
  audit: 0 通过 / 4 内容不符（SUBTITLE_MISMATCH）
  probe: 0 有可用轨道 / 5 无可用轨道（NO_USABLE_SUBS）
  asr:   0 成功 / 6 环境不可用（ASR_UNAVAILABLE）/ 7 转写失败（ASR_FAILED）
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 按教材章给的关键词表：命中 ≥ MIN_HITS 即判定"这一分 P 内容对得上"。
# 表中只放各章无法误撞的标志词（人名/文件名/口号），避免"革命""建设"这类泛词。
AUDIT_KEYWORDS = {
    1: ["鸦片战争", "虎门销烟", "南京条约", "三元里", "半殖民地"],
    2: ["太平天国", "天朝田亩", "洋务", "维新", "戊戌"],
    3: ["辛亥革命", "孙中山", "同盟会", "三民主义", "武昌"],
    4: ["五四", "共产党", "新文化", "工人运动", "国共合作"],
    5: ["土地革命", "井冈山", "长征", "遵义", "农村包围城市"],
    6: ["抗日", "统一战线", "延安", "持久战", "敌后"],
    7: ["解放战争", "三大战役", "渡江", "共同纲领", "第二条战线"],
    8: ["三大改造", "过渡时期", "五年计划", "社会主义改造", "人民代表大会"],
    9: ["改革开放", "邓小平", "十一届三中全会", "市场经济", "特区"],
    10: ["新时代", "小康社会", "中国梦", "一带一路", "中国式现代化"],
}
MIN_HITS = 2   # 命中 >=2 判 ok；1 判 weak；0 或出现异物词判 mismatch

# 串台检测用的"异物词"：出现即说明抓到的字幕属于别的视频
FOREIGN_WORDS = ["评测", "iPhone", "充电宝", "vlog", "靶场", "开箱"]


def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, indent=1) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def die(msg, code=2, **extra):
    obj = {"error": msg, "exitCode": code}
    obj.update(extra)
    sys.stderr.write("ERROR: %s\n" % msg)
    emit(obj, code)


def _workdir(a):
    return a.workdir or "runs"


def _video_dir(a, vid):
    return os.path.join(_workdir(a), vid)


def _read(path, default=None):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return fh.read()
    except OSError:
        return default


def _chapter_of(title):
    """从分 P 标题里取章号：'第一章：xxx' / '第 1 章 xxx' → 1。"""
    m = re.search(r"第\s*([一二三四五六七八九十]+|\d+)\s*章", title or "")
    if not m:
        return None
    tok = m.group(1)
    if tok.isdigit():
        return int(tok)
    cn = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
          "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    return cn.get(tok)


# --------------------------------------------------------------- audit
def cmd_audit(a):
    """内容级校验：逐分 P 统计关键词命中与异物词，判定字幕是否串台。"""
    vid = a.video_id
    vdir = _video_dir(a, vid)
    byp = os.path.join(vdir, "by_p")
    meta_path = os.path.join(vdir, "meta.json")
    meta = json.loads(_read(meta_path, "{}") or "{}")
    titles = {p["index"]: p.get("title") or p.get("part") or ""
              for p in (meta.get("parts") or [])}

    custom = {}
    if a.expect:
        for seg in a.expect.split(";"):
            if "=" not in seg:
                continue
            k, v = seg.split("=", 1)
            try:
                custom[int(k)] = [x.strip() for x in v.split(",") if x.strip()]
            except ValueError:
                continue

    rows, mismatched = [], []
    for name in (sorted(os.listdir(byp)) if os.path.isdir(byp) else []):
        m = re.match(r"^p(\d{2})\.txt$", name)
        if not m:
            continue
        idx = int(m.group(1))
        text = _read(os.path.join(byp, name), "") or ""
        chapter = _chapter_of(titles.get(idx, "")) or idx
        kws = custom.get(idx) or AUDIT_KEYWORDS.get(chapter) or []
        hits = [k for k in kws if k in text]
        foreign = [w for w in FOREIGN_WORDS if w in text]
        verdict = "ok"
        if not text.strip():
            verdict = "empty"
        elif foreign or (kws and len(hits) == 0):
            verdict = "mismatch"
        elif kws and len(hits) < min(MIN_HITS, len(kws)):
            verdict = "weak"
        rows.append({"p": idx, "chapter": chapter, "chars": len(text),
                     "hits": len(hits), "matched": hits,
                     "foreign": foreign, "verdict": verdict})
        if verdict in ("mismatch", "empty"):
            mismatched.append(idx)

    weak = [r["p"] for r in rows if r["verdict"] == "weak"]
    ok = not mismatched
    out = {"videoId": vid, "minHits": MIN_HITS, "parts": rows,
           "mismatched": mismatched, "weak": weak, "ok": ok,
           "verdict": "ok" if ok else "SUBTITLE_MISMATCH"}
    emit(out, 0 if ok else 4)


# --------------------------------------------------------------- probe
def _bili_session(cookies):
    import http.cookiejar
    import urllib.request
    cj = http.cookiejar.MozillaCookieJar(cookies)
    cj.load(ignore_discard=True, ignore_expires=True)
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def _get(op, url):
    import urllib.request
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    return json.loads(op.open(req, timeout=45).read().decode("utf-8"))


def _ts(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def cmd_probe(a):
    """多轮探测字幕轨：只保留 max(end) 落在本 P 时长 85%~115% 的轨道。"""
    raw = a.url or ""
    m = re.search(r"(BV[0-9A-Za-z]{10})", raw)
    vid = a.video_id or (m.group(1) if m else None)
    if not vid:
        die("缺少 --video-id 或 URL 中无 BV 号", 2)

    cookies = a.cookies or os.environ.get("BILI_COOKIES") or os.environ.get("VK_COOKIES")
    if not cookies or not os.path.isfile(cookies):
        die("B 站探测需要登录态 cookie（--cookies 或 BILI_COOKIES）", 2)

    op = _bili_session(cookies)
    view = _get(op, "https://api.bilibili.com/x/web-interface/view?bvid=" + vid)
    if view.get("code") != 0:
        die("B 站 view 接口失败：%s" % view.get("message"), 5, videoId=vid)
    aid = view["data"]["aid"]
    pages = view["data"]["pages"]

    subs_dir = os.path.join(_video_dir(a, vid), "subs")
    os.makedirs(subs_dir, exist_ok=True)

    best = {}
    for rnd in range(1, a.rounds + 1):
        for p in pages:
            idx = p["page"]
            if idx in best:
                continue
            try:
                r = _get(op, "https://api.bilibili.com/x/player/v2?aid=%d&cid=%d"
                         % (aid, p["cid"]))
                subs = (((r.get("data") or {}).get("subtitle") or {}).get("subtitles") or [])
            except Exception:
                continue
            for s in subs:
                try:
                    body = _get(op, "https:" + s["subtitle_url"]).get("body") or []
                except Exception:
                    continue
                if len(body) < 40:
                    continue
                end = max(x["to"] for x in body)
                ratio = end / float(p["duration"] or 1)
                if 0.85 <= ratio <= 1.15:
                    best[idx] = (s.get("lan"), body, ratio)
                    break
        if len(best) == len(pages):
            break

    rows = []
    for idx, (lan, body, ratio) in sorted(best.items()):
        lines, k = [], 0
        for seg in body:
            text = (seg.get("content") or "").strip()
            if not text:
                continue
            k += 1
            lines.append("%d\n%s --> %s\n%s\n"
                         % (k, _ts(seg["from"]), _ts(seg["to"]), text))
        dest = os.path.join(subs_dir, "%02d_ai-zh.srt" % idx)
        with open(dest, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines))
        rows.append({"p": idx, "lan": lan, "segments": k,
                     "coverage": round(ratio, 3), "file": os.path.basename(dest)})

    missing = [p["page"] for p in pages if p["page"] not in best]
    out = {"videoId": vid, "rounds": a.rounds, "partCount": len(pages),
           "usable": [r["p"] for r in rows], "missing": missing, "parts": rows,
           "verdict": "ok" if rows else "NO_USABLE_SUBS"}
    emit(out, 0 if rows else 5)


# --------------------------------------------------------------- asr
def _ffmpeg():
    from shutil import which
    cand = os.environ.get("VK_FFMPEG") or "ffmpeg"
    return which(cand)


def _load_audio(ffmpeg, path, sr=16000):
    import numpy as np
    cmd = [ffmpeg, "-nostdin", "-v", "error", "-i", path,
           "-f", "s16le", "-ac", "1", "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def _fmt_srt(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def cmd_asr(a):
    """本地 ASR 兜底：逐分 P 转写 → SRT（不保留音频）。"""
    try:
        import numpy  # noqa: F401
        from faster_whisper import WhisperModel
    except Exception as e:
        die("缺少依赖（numpy / faster-whisper）：%s" % e, 6, verdict="ASR_UNAVAILABLE")

    ffmpeg = _ffmpeg()
    if not ffmpeg:
        die("找不到 ffmpeg（ASR 解码需要）", 6, verdict="ASR_UNAVAILABLE")

    vid = a.video_id
    vdir = _video_dir(a, vid)
    meta_path = os.path.join(vdir, "meta.json")
    meta = json.loads(_read(meta_path, "{}") or "{}")
    parts = meta.get("parts") or []
    if not parts:
        die("缺 %s（先跑 meta）" % meta_path, 7, verdict="ASR_FAILED")

    want = [int(x) for x in a.parts.split(",") if x.strip()] if a.parts else \
        [p["index"] for p in parts]
    by_idx = {p["index"]: p for p in parts}
    outdir = os.path.join(vdir, "manual")
    os.makedirs(outdir, exist_ok=True)

    prompt = ("中国近现代史纲要。鸦片战争、太平天国、洋务运动、维新变法、辛亥革命、"
              "新民主主义革命、抗日战争、解放战争、社会主义改造、改革开放。")

    t0 = time.time()
    try:
        model = WhisperModel(a.model, device="cpu", compute_type="int8",
                             download_root=(a.model_dir or None),
                             cpu_threads=max(1, a.threads))
    except Exception as e:
        # 模型不在本地时 faster-whisper 会去连 HuggingFace；直连常被拒，
        # 需要 HF_ENDPOINT 指向镜像（或直接用 --model-dir 指本地目录）。
        die("加载 ASR 模型失败：%s" % str(e)[:300], 6, verdict="ASR_UNAVAILABLE",
            hint="离线环境请用 --model-dir 指向本地模型目录，或设 HF_ENDPOINT=https://hf-mirror.com")
    loaded = round(time.time() - t0, 1)

    rows, failed = [], []
    tmpdir = tempfile.mkdtemp(prefix="vk_asr_")
    try:
        for idx in want:
            p = by_idx.get(idx)
            if not p:
                continue
            out = os.path.join(outdir, "%02d_asr.srt" % idx)
            if os.path.isfile(out) and not a.refresh:
                rows.append({"p": idx, "reused": True})
                continue
            audio = os.path.join(tmpdir, "p%02d.m4a" % idx)
            if a.download:
                ytdlp = a.ytdlp or "yt-dlp"
                cmd = [ytdlp, "--no-warnings", "-f", "bestaudio/best",
                       "--playlist-items", str(idx),
                       "-o", os.path.join(tmpdir, "p%(playlist_index)02d.%(ext)s"),
                       "--", a.url]
                ck = a.cookies or os.environ.get("BILI_COOKIES") or os.environ.get("VK_COOKIES")
                if ck and os.path.isfile(ck):
                    cmd[1:1] = ["--cookies", ck]
                rc = subprocess.run(cmd, capture_output=True).returncode
                if rc != 0 or not os.path.isfile(audio):
                    failed.append(idx)
                    continue
            else:
                src = os.path.join(a.audio_dir or "audio", "p%02d.m4a" % idx)
                if not os.path.isfile(src):
                    failed.append(idx)
                    continue
                audio = src

            try:
                arr = _load_audio(ffmpeg, audio)
                t1 = time.time()
                segs, _info = model.transcribe(
                    arr, language="zh", beam_size=a.beam,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 400},
                    initial_prompt=prompt, condition_on_previous_text=False,
                    no_speech_threshold=0.6, temperature=[0.0, 0.2, 0.4])
                lines, n = [], 0
                for seg in segs:
                    text = (seg.text or "").strip()
                    if not text:
                        continue
                    n += 1
                    lines.append("%d\n%s --> %s\n%s\n"
                                 % (n, _fmt_srt(seg.start), _fmt_srt(seg.end), text))
                with open(out, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write("\n".join(lines))
                dur = len(arr) / 16000.0
                rows.append({"p": idx, "segments": n,
                             "rtf": round((time.time() - t1) / max(dur, 1), 2)})
            except Exception as e:
                failed.append(idx)
                rows.append({"p": idx, "error": str(e)[:200]})
    finally:
        if a.download and os.path.isdir(tmpdir):
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    out = {"videoId": vid, "model": a.model, "modelLoadSec": loaded,
           "parts": rows, "failed": failed,
           "verdict": "ok" if not failed else "ASR_PARTIAL"}
    emit(out, 0 if not failed else 7)



# --------------------------------------------------------------- template
TEMPLATE_SECTIONS = ["简介", "目录", "正文", "附录"]


def cmd_template(a):
    """识别"沉淀成知识卡 + 整合成参考书"这套提示词模板，抽出 url/videoId/deliverable。

    模板形如：
      把这个视频（<标题>）沉淀成知识卡，并整合知识卡形成一本包含视频中所讲解
      所有概念的参考书（简介+目录+正文+附录）：<链接>
    """
    text = a.prompt or ""
    m = re.search(r"(BV[0-9A-Za-z]{10})", text)
    vid = m.group(1) if m else None
    url_m = re.search(r"https?://[^\s)）\]]+", text)
    url = url_m.group(0) if url_m else ("https://www.bilibili.com/video/%s/" % vid if vid else None)

    is_book = bool(re.search(r"参考书|一本书|整合", text)) and         any(k in text for k in TEMPLATE_SECTIONS)
    wants_cards = bool(re.search(r"知识卡|卡片", text))
    title_m = re.search(r"（([^）]{2,120})）", text)

    out = {"recognized": bool(vid or url), "videoId": vid, "url": url,
           "titleHint": title_m.group(1) if title_m else None,
           "deliverable": "book" if is_book else ("cards" if wants_cards else "unknown"),
           "sections": TEMPLATE_SECTIONS if is_book else [],
           "verdict": "ok" if (vid or url) else "NO_VIDEO_IN_PROMPT"}
    emit(out, 0 if out["recognized"] else 8)


# --------------------------------------------------------------- bookplan
def cmd_bookplan(a):
    """据 meta + 已写的卡片，给出参考书的编/章骨架（不含正文，正文由模型写）。

    只做确定性估算：每编 = 一集；每编建议章数 = max(2, ceil(核心要点数 / 8))。
    """
    vid = a.video_id
    vdir = _video_dir(a, vid)
    meta = json.loads(_read(os.path.join(vdir, "meta.json"), "{}") or "{}")
    parts = meta.get("parts") or []
    cards_dir = a.cards_dir or "cards"

    rows, total_ch = [], 0
    for p in parts:
        idx = p["index"]
        path = os.path.join(cards_dir, "card-%s-p%02d.md" % (vid, idx))
        text = _read(path, "") or ""
        points = len(re.findall(r"^\s*[-*]\s*\[\d{1,3}:\d{2}\]", text, re.M))
        concepts = len(re.findall(r"^\|\s*[^|]+\|", text, re.M))
        chapters = max(2, min(4, (points + 7) // 8)) if points else 0
        total_ch += chapters
        rows.append({"part": idx, "title": (p.get("title") or "")[:60],
                     "durationSec": p.get("durationSec"),
                     "cardExists": bool(text), "points": points,
                     "chapters": chapters})

    out = {"videoId": vid, "deliverable": "book",
           "sections": TEMPLATE_SECTIONS,
           "bianCount": len(parts), "chapterCount": total_ch,
           "parts": rows,
           "ready": all(r["cardExists"] for r in rows) if rows else False,
           "verdict": "ok" if rows else "NO_META"}
    emit(out, 0 if rows else 2)


def build_parser(sub):
    """注册到 vk_chain 的子命令（由 vk_chain.main 调用）。"""
    au = sub.add_parser("audit", help="内容级校验：字幕是否串台（关键词命中）")
    au.add_argument("--video-id", required=True)
    au.add_argument("--workdir", default=argparse.SUPPRESS)
    au.add_argument("--expect", default="",
                    help='自定义关键词表，形如 "1=鸦片战争,虎门销烟;2=太平天国"')
    au.set_defaults(func=cmd_audit)

    pr = sub.add_parser("probe", help="多轮探测字幕轨并按分 P 时长择优")
    pr.add_argument("--url", default="")
    pr.add_argument("--video-id")
    pr.add_argument("--cookies")
    pr.add_argument("--workdir", default=argparse.SUPPRESS)
    pr.add_argument("--rounds", type=int, default=8)
    pr.set_defaults(func=cmd_probe)

    ar = sub.add_parser("asr", help="本地 ASR 兜底转写（不保留音频）")
    ar.add_argument("--video-id", required=True)
    ar.add_argument("--workdir", default=argparse.SUPPRESS)
    ar.add_argument("--parts", default="", help="缺省=全部分 P")
    ar.add_argument("--model", default="medium")
    ar.add_argument("--model-dir", default=os.environ.get("VK_MODEL_DIR", ""))
    ar.add_argument("--audio-dir", default="audio")
    ar.add_argument("--download", action="store_true",
                    help="就地用 yt-dlp 取音频到临时目录，转完即删")
    ar.add_argument("--url", default="")
    ar.add_argument("--cookies")
    ar.add_argument("--ytdlp")
    ar.add_argument("--threads", type=int, default=4)
    ar.add_argument("--beam", type=int, default=5)
    ar.add_argument("--refresh", action="store_true")
    ar.set_defaults(func=cmd_asr)

    tp = sub.add_parser("template", help="识别「沉淀知识卡+整合参考书」提示词模板")
    tp.add_argument("--prompt", required=True)
    tp.set_defaults(func=cmd_template)

    bp = sub.add_parser("bookplan", help="据 meta 与卡片给出参考书的编/章骨架")
    bp.add_argument("--video-id", required=True)
    bp.add_argument("--cards-dir", default="cards")
    bp.add_argument("--workdir", default=argparse.SUPPRESS)
    bp.set_defaults(func=cmd_bookplan)
    return sub


if __name__ == "__main__":
    ap = argparse.ArgumentParser(prog="vk_signals")
    build_parser(ap.add_subparsers(dest="cmd", required=True))
    args = ap.parse_args()
    args.func(args)
