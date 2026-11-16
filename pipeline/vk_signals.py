# -*- coding: utf-8 -*-
"""信号节点的确定性内核：字幕内容校验 / 多轮字幕探测 / 本地 ASR 兜底。

这三个命令对应三轮实战踩出来的三个坑：
  1. audit  —— 平台字幕可能"时长对得上、内容却是别的视频"（串台），
               只比时长拦不住。判据**不再写死成某一学科的关键词**，而是由
               视频标题/分P标题自动生成锚点，再比较各分P字幕之间的相似度；
               判不了时显式返回 unverified，绝不静默判 ok（见 vk_audit.py）。
  2. probe  —— B 站 x/player/v2 的返回不稳定：同一分 P 时而有时而无、
               时而返回别处的字幕；单次探测不可信，要多轮采样再按时长择优。
  3. asr    —— 没有可用字幕时的兜底转写；faster-whisper 的 PyAV 解码在
               某些版本组合下会 TypeError，所以统一用 ffmpeg 解码成 numpy。
               转完可用 --merge 重建 transcript.jsonl，让下游清洗真正吃到新字幕。

每个命令都只输出一个 JSON 到 stdout：
  audit: 始终 exit 0，verdict = ok / review / mismatch / unverified（由链上 gate 判断）
  probe: 始终 exit 0，verdict = ok / NO_USABLE_SUBS（只做侦察，不阻断主链）
  asr:   0 成功（含部分成功）/ 6 环境不可用（ASR_UNAVAILABLE）/ 7 全部失败（ASR_FAILED）
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

import vk_audit
import vk_pipeline as vp


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


# --------------------------------------------------------------- audit
def cmd_audit(a):
    """内容级校验：标题锚点 + 跨分 P 相似度，判定字幕是否串台。

    判据由视频自身标题生成，不再依赖任何学科词表；
    by_p 不存在时直接读 transcript.jsonl，避免"没数据 → 静默判 ok"。
    """
    vid = a.video_id
    vdir = _video_dir(a, vid)
    expect = vk_audit._parse_expect(a.expect)
    foreign = [x.strip() for x in re.split(r"[,，]", a.foreign_words or "") if x.strip()]
    try:
        out = vk_audit.audit_run(vdir, expect=expect, foreign=foreign)
    except Exception as e:  # 审计自身出错也必须显式暴露，不能吞掉
        out = {"ok": False, "verdict": "unverified",
               "warning": "内容校验执行失败：%s" % str(e)[:200],
               "mismatched": [], "weak": [], "unverified": [], "empty": [], "parts": []}
    out["videoId"] = vid
    # 始终 exit 0：由链上 transcriptGate 读 verdict 决定走 ASR 还是继续；
    # 非 0 会让节点直接失败，gate 拿不到 $.audit，又退回"静默 ok"。
    emit(out, 0)


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
        emit({"videoId": vid, "verdict": "NO_USABLE_SUBS",
              "reason": "B 站探测需要登录态 cookie（--cookies 或 BILI_COOKIES）"}, 0)

    try:
        op = _bili_session(cookies)
        view = _get(op, "https://api.bilibili.com/x/web-interface/view?bvid=" + vid)
    except Exception as e:
        emit({"videoId": vid, "verdict": "NO_USABLE_SUBS",
              "reason": "B 站探测请求失败：%s" % type(e).__name__}, 0)
    if view.get("code") != 0:
        emit({"videoId": vid, "verdict": "NO_USABLE_SUBS",
              "reason": "B 站 view 接口失败：%s" % view.get("message")}, 0)
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
    # 只做侦察、不阻断主链：探测失败（没 cookie / 接口抖动）也要 exit 0，
    # 由 verdict 表达结果；否则 runner 会把 onError 当成硬失败。
    emit(out, 0)


# --------------------------------------------------------------- asr
def _ffmpeg():
    """跨平台找 ffmpeg：VK_FFMPEG → PATH → WinGet 包目录 → imageio-ffmpeg。"""
    return vp.resolve_ffmpeg()


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


def _parse_parts(raw, all_parts):
    """--parts 接受 "1,2,5" / "[1, 2, 5]" 两种写法；缺省=全部分 P。"""
    if not raw:
        return list(all_parts)
    s = raw.strip()
    vals = []
    if s.startswith("["):
        try:
            vals = [int(x) for x in json.loads(s)]
        except (ValueError, TypeError):
            vals = []
    if not vals:
        vals = [int(x) for x in re.split(r"[,，\s]+", s) if x.strip().isdigit()]
    return [v for v in vals if v in all_parts] or list(all_parts)


def _asr_prompt(meta, part):
    """提示词只取自视频标题/分P标题，不再写死任何学科。"""
    title = (meta.get("title") or "")[:80]
    pt = (part.get("title") or "")[:60]
    head = "以下是《%s》" % title
    if pt:
        head += "（%s）" % pt
    return head + "的课堂录音。请用简体中文逐句转写，保留人名、术语和公式读法，不要总结。"


def _audio_for(tmpdir, audio_dir, idx):
    for d in (tmpdir, audio_dir):
        if not d or not os.path.isdir(d):
            continue
        for ext in ("m4a", "webm", "mp3", "wav", "aac", "opus", "flac"):
            p = os.path.join(d, "p%02d.%s" % (idx, ext))
            if os.path.isfile(p):
                return p
    return None


def cmd_asr(a):
    """本地 ASR 兜底：逐分 P 转写 → SRT（不保留音频）。

    --merge：转完立即重建 transcript.jsonl（ASR 轨优先），下游 clean 才能吃到新字幕；
    --audit：重建后再跑一次内容校验，把"修没修好"一并返回。

    已有 manual/NN_asr.srt 的分 P 直接复用：不加载模型、不要求 ffmpeg，
    这样"上次转好、这次只重建"的场景不会被模型下载卡住。
    """
    vid = a.video_id
    vdir = _video_dir(a, vid)
    meta_path = os.path.join(vdir, "meta.json")
    meta = json.loads(_read(meta_path, "{}") or "{}")
    parts = meta.get("parts") or []
    if not parts:
        die("缺 %s（先跑 meta）" % meta_path, 7, verdict="ASR_FAILED")

    by_idx = {p["index"]: p for p in parts}
    want = _parse_parts(a.parts, list(by_idx))
    outdir = os.path.join(vdir, "manual")
    os.makedirs(outdir, exist_ok=True)

    rows, failed, ok_count = [], [], 0
    todo = []
    for idx in want:
        out = os.path.join(outdir, "%02d_asr.srt" % idx)
        if os.path.isfile(out) and not a.refresh:
            rows.append({"p": idx, "reused": True})
            ok_count += 1
        else:
            todo.append(idx)

    loaded = 0
    if todo:
        try:
            import numpy  # noqa: F401
            from faster_whisper import WhisperModel
        except Exception as e:
            die("缺少依赖（numpy / faster-whisper）：%s" % e, 6, verdict="ASR_UNAVAILABLE",
                hint="pip install -U faster-whisper；仅走平台字幕时不需要装")

        ffmpeg = _ffmpeg()
        if not ffmpeg:
            die("找不到 ffmpeg（ASR 解码需要）", 6, verdict="ASR_UNAVAILABLE",
                hint="装 ffmpeg（winget install Gyan.FFmpeg），或用 VK_FFMPEG 指路径")

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

        ytdlp = vp.ytdlp_cmd(getattr(a, "ytdlp", None))
        ck = a.cookies or os.environ.get("BILI_COOKIES") or os.environ.get("VK_COOKIES")
        tmpdir = tempfile.mkdtemp(prefix="vk_asr_")
        try:
            for idx in todo:
                p = by_idx.get(idx)
                if not p:
                    continue
                out = os.path.join(outdir, "%02d_asr.srt" % idx)
                if a.download:
                    if not ytdlp:
                        failed.append(idx)
                        rows.append({"p": idx, "error": "找不到 yt-dlp，无法下载音频"})
                        continue
                    cmd = ytdlp + ["--no-warnings", "-f", "bestaudio/best",
                                   "--playlist-items", str(idx),
                                   "-o", os.path.join(tmpdir, "p%(playlist_index)02d.%(ext)s"),
                                   "--", a.url]
                    if ck and os.path.isfile(ck):
                        cmd[1:1] = ["--cookies", ck]
                    rc = subprocess.run(cmd, capture_output=True).returncode
                    audio = _audio_for(tmpdir, None, idx)
                    if rc != 0 or not audio:
                        failed.append(idx)
                        rows.append({"p": idx, "error": "yt-dlp 取音频失败 (exit %s)" % rc})
                        continue
                else:
                    audio = _audio_for(None, a.audio_dir or "audio", idx)
                    if not audio:
                        failed.append(idx)
                        rows.append({"p": idx, "error": "找不到音频 p%02d.*（--audio-dir）" % idx})
                        continue

                try:
                    arr = _load_audio(ffmpeg, audio)
                    t1 = time.time()
                    segs, _info = model.transcribe(
                        arr, language="zh", beam_size=a.beam,
                        vad_filter=True,
                        vad_parameters={"min_silence_duration_ms": 400},
                        initial_prompt=_asr_prompt(meta, p),
                        condition_on_previous_text=False,
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
                    if n:
                        ok_count += 1
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

    rebuilt = None
    audit = None
    if getattr(a, "merge", False) and ok_count:
        records, stats, missing = vp.rebuild_transcript(vdir, meta)
        rebuilt = {"segments": len(records), "parts": stats, "missing": missing}
        audit = vk_audit.audit_run(vdir, meta, prefer_transcript=True)
    elif getattr(a, "audit", False):
        audit = vk_audit.audit_run(vdir, meta)

    verdict = "ok" if not failed else ("ASR_PARTIAL" if ok_count else "ASR_FAILED")
    out = {"videoId": vid, "model": a.model, "modelLoadSec": loaded,
           "parts": rows, "failed": failed, "rebuilt": rebuilt, "audit": audit,
           "verdict": verdict}
    emit(out, 0 if ok_count else 7)



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
    # 始终 exit 0：没给 prompt 是正常情况（vk_run 的输入里就没有 prompt），
    # 不能因此让节点失败并触发主链 bail；deliverable=unknown 由 bookGate 跳过成书。
    emit(out, 0)


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
    au = sub.add_parser("audit", help="内容级校验：字幕是否串台（标题锚点+跨分P相似度）")
    au.add_argument("--video-id", required=True)
    au.add_argument("--workdir", default=argparse.SUPPRESS)
    au.add_argument("--expect", default="",
                    help='手工关键词（可选），形如 "1=函数,极限;2=导数,微分"')
    au.add_argument("--foreign-words", default="",
                    help="可选：异物词，逗号分隔；仅作为辅助证据")
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
    ar.add_argument("--merge", action="store_true",
                    help="转写后重建 transcript.jsonl（ASR 轨优先），供下游 clean 使用")
    ar.add_argument("--audit", action="store_true", help="转写后顺带跑一次内容校验")
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
