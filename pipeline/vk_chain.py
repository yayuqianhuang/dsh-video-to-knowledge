#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vk_chain.py — AJTC 链的确定性内核（供 gen.video-to-knowledge 的 agentStep 调用）

每个子命令都只往 stdout 打**一个 JSON**，正好是链上某个黑板块的内容：

    meta        → $.meta        （视频元数据，含各分 P 时长）
    transcript  → $.transcript  （字幕段表，含 segmentCount / coveredSec）
    cards       → $.card        （从 agent 写好的正文组装卡片对象）
    quality     → $.quality     （五项机器校验：frontmatter/时间戳/字数/敏感/占位符）
    outline     → $.outline     （把卡片要点灌进大纲）

设计原则：
  * 复用 vk_pipeline.py，不重复实现抓取/解析/清洗/切块逻辑；
  * 幂等：meta.json / transcript.jsonl 已存在就直接复用，不重复联网；
  * 绝不打印 cookie 内容；cookie 只透传给 yt-dlp 子进程；
  * 任何失败走 stderr + 非 0 退出码，绝不产出"看起来成功"的半成品 JSON。

链上用法（agentStep 的 exec 字段）：
    python scripts/vk_chain.py meta       --url <URL> [--cookies <F>]
    python scripts/vk_chain.py transcript --url <URL> [--cookies <F>]
    python scripts/vk_chain.py cards      --cards-dir cards --video-id <ID>
    python scripts/vk_chain.py quality    --card card.json --meta runs/<ID>/meta.json
    python scripts/vk_chain.py outline    --card card.json --outline <大纲.md>
"""

import argparse
import json
import os
import re
import shutil
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vk_pipeline as vp  # noqa: E402


def emit(obj):
    """唯一输出通道：一个 JSON 到 stdout（若给了 --out，同时落一份无 BOM 文件）。"""
    text = json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    out = getattr(emit, "out_path", None)
    if out:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    sys.stdout.write(text)
    return 0


def die(msg, code=2):
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(code)

# ---------------------------------------------------------------- meta

def cmd_meta(a):
    url = a.url
    vid = a.video_id or vp.detect_video_id(url)[0]
    if not vid:
        die(f"无法解析视频号：{url}")
    viddir = os.path.join(a.workdir, vid)
    os.makedirs(viddir, exist_ok=True)

    meta_path = os.path.join(viddir, "meta.json")
    if os.path.isfile(meta_path) and not a.refresh:
        meta = vp.read_json(meta_path)
    else:
        meta = _build_meta_from_ytdlp(url, vid, a)
        vp.write_json(meta_path, meta)

    parts = meta.get("parts") or []
    return emit({
        "platform": meta.get("platform"),
        "videoId": vid,
        "title": meta.get("title"),
        "uploader": meta.get("uploader") or "",
        "durationSec": meta.get("totalDurationSec") or 0,
        "publishedAt": meta.get("publishedAt") or "unknown",
        "coverUrl": meta.get("coverUrl"),
        "subtitleTracks": meta.get("subtitleTracks") or [],
        "partCount": len(parts),
        "parts": [{"index": p["index"], "durationSec": p.get("durationSec"),
                   "offsetSec": p.get("offsetSec"), "title": p.get("title")}
                  for p in parts],
        "metaPath": meta_path,
    })


def _build_meta_from_ytdlp(url, vid, a, require_login=False):
    """取元数据。B 站元数据游客可见，因此默认**不要求**登录；
    只有 require_login=True（如确需连字幕一起抓的路径）才强制 cookie。"""
    ytdlp = vp.resolve_ytdlp(getattr(a, "ytdlp", None))
    if not ytdlp:
        die("找不到 yt-dlp（--ytdlp / $VK_YTDLP）")
    platform = vp.platform_of(url)
    cookies = a.cookies or os.environ.get("BILI_COOKIES") or os.environ.get("VK_COOKIES")
    if cookies and not os.path.isfile(cookies):
        die(f"cookie 文件不存在：{cookies}")
    if platform == "bilibili" and require_login and not cookies:
        die("B 站抓字幕需要登录态：--cookies <cookie文件> 或 $BILI_COOKIES")

    cmd = [ytdlp, "--no-warnings"]
    if cookies:
        cmd += ["--cookies", cookies]
    cmd += ["--print", "%(playlist_index)s\t%(duration)s\t%(playlist_title)s\t%(title)s", url]

    code, out, err = vp.run_cmd(cmd)
    if code != 0:
        die(f"yt-dlp 取元数据失败：{(err or out)[-600:]}")

    parts = []
    for line in out.splitlines():
        f = line.rstrip("\n").split("\t")
        if len(f) < 4:
            continue
        try:
            dur = float(f[1])
        except ValueError:
            continue
        try:
            idx = int(f[0])
        except ValueError:
            idx = len(parts) + 1
        parts.append({"index": idx, "durationSec": dur,
                      "playlistTitle": None if f[2] in ("NA", "") else f[2],
                      "title": None if f[3] in ("NA", "") else f[3]})
    if not parts:
        die("没解析到任何分 P 元数据")
    parts.sort(key=lambda p: p["index"])
    offset = 0.0
    for p in parts:
        p["offsetSec"] = round(offset, 3)
        offset += p["durationSec"]

    return {
        "videoId": vid, "platform": platform, "url": url,
        "title": parts[0].get("playlistTitle") or parts[0].get("title") or vid,
        "uploader": "", "publishedAt": "unknown", "coverUrl": None,
        "lang": "ai-zh", "totalDurationSec": round(offset, 3),
        "subtitleTracks": [], "parts": parts,
    }

# ---------------------------------------------------------------- transcript

def cmd_transcript(a):
    url = a.url
    vid = a.video_id or vp.detect_video_id(url)[0]
    if not vid:
        die(f"无法解析视频号：{url}")
    viddir = os.path.join(a.workdir, vid)
    os.makedirs(viddir, exist_ok=True)

    meta_path = os.path.join(viddir, "meta.json")
    if os.path.isfile(meta_path):
        meta = vp.read_json(meta_path)
    else:
        meta = _build_meta_from_ytdlp(url, vid, a, require_login=True)
        vp.write_json(meta_path, meta)

    tpath = os.path.join(viddir, "transcript.jsonl")
    if os.path.isfile(tpath) and not a.refresh:
        records = [json.loads(l) for l in open(tpath, encoding="utf-8") if l.strip()]
    else:
        records, _ = _fetch_and_convert(url, vid, meta, a)

    if not records:
        die("NO_TRANSCRIPT：没有解析到任何字幕段", code=3)

    covered = max(r["endSec"] for r in records) - min(r["startSec"] for r in records)
    # 覆盖率按"整视频时间轴跨度"算，多分 P 合并后末端即接近总时长
    return emit({
        "source": "platform",
        "lang": a.lang or meta.get("lang") or "ai-zh",
        "segmentsPath": tpath,
        "segmentCount": len(records),
        "coveredSec": int(round(covered)),
        "firstSec": min(r["startSec"] for r in records),
        "lastSec": max(r["endSec"] for r in records),
        "durationSec": meta.get("totalDurationSec") or 0,
        "partCount": len(meta.get("parts") or []),
    })


def _fetch_and_convert(url, vid, meta, a):
    """抓字幕（yt-dlp --cookies）+ 多 P 偏移合并成 transcript.jsonl。"""
    ytdlp = vp.resolve_ytdlp(getattr(a, "ytdlp", None))
    if not ytdlp:
        die("找不到 yt-dlp")
    platform = vp.platform_of(url)
    cookies = a.cookies or os.environ.get("BILI_COOKIES") or os.environ.get("VK_COOKIES")
    if platform == "bilibili":
        if not cookies:
            die("B 站需要登录态：--cookies <cookie文件> 或 $BILI_COOKIES")
        if not os.path.isfile(cookies):
            die(f"cookie 文件不存在：{cookies}")

    viddir = os.path.join(a.workdir, vid)
    subsdir = os.path.join(viddir, "subs")
    os.makedirs(subsdir, exist_ok=True)

    cmd = [ytdlp, "--no-warnings"]
    if cookies:
        cmd += ["--cookies", cookies]
    cmd += ["--write-subs", "--write-auto-subs",
            "--sub-langs", a.sub_langs,
            "--skip-download", "--no-overwrites",
            "-o", os.path.join(subsdir, "%(playlist_index)02d_%(title)s.%(ext)s"),
            url]
    code, out, err = vp.run_cmd(cmd)
    if code != 0:
        sys.stderr.write(f"WARN: yt-dlp 退出码 {code}（可能是部分分 P 无字幕）\n")

    srts = vp._find_srts(viddir)
    if not srts:
        die("NO_TRANSCRIPT：没有下载到任何 .srt（cookie 失效 / 无 AI 字幕 / 语言代码不对）", code=3)

    records, stats = [], []
    for p in sorted(meta.get("parts") or [], key=lambda x: x["index"]):
        idx = p["index"]
        if idx not in srts:
            continue
        off = p.get("offsetSec", 0)
        n = 0
        for s, e, text in vp.parse_srt(srts[idx]):
            records.append({"idx": len(records),
                            "startSec": int(round(s + off)),
                            "endSec": int(round(e + off)),
                            "text": text})
            n += 1
        stats.append({"index": idx, "segments": n})

    tpath = os.path.join(viddir, "transcript.jsonl")
    with open(tpath, "w", encoding="utf-8", newline="\n") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    return records, stats

# ---------------------------------------------------------------- doctor / credential

_HOME = os.path.expanduser("~")
COOKIE_CANDIDATES = [
    os.path.join(_HOME, ".workbuddy", "secrets", "bili-cookies.txt"),
    os.path.join(_HOME, ".workbuddy", "secrets", "bili-cookies"),
]
SESSDATA_FILE = os.path.join(_HOME, ".workbuddy", "secrets", "bili-sessdata")


def _credential():
    """解析 B 站登录凭证来源；只返回路径/布尔，绝不返回 cookie 值。"""
    explicit = os.environ.get("BILI_COOKIES") or os.environ.get("VK_COOKIES")
    path = None
    for c in ([explicit] if explicit else []) + COOKIE_CANDIDATES:
        if c and os.path.isfile(c):
            path = c
            break

    has_sessdata = False
    if path:
        try:
            with open(path, "rb") as fh:
                blob = fh.read()
            # 只判断存在性，不解析、不打印值
            has_sessdata = b"SESSDATA" in blob
        except OSError:
            has_sessdata = False

    if path and has_sessdata:
        return {"loginState": "valid", "mode": "cookies", "cookiesPath": path}
    if os.path.isfile(SESSDATA_FILE) and os.path.getsize(SESSDATA_FILE) > 0:
        # 只有裸 SESSDATA 时仍可走 --add-header，但没有完整 cookie 时字幕常拿不到
        return {"loginState": "partial", "mode": "sessdata",
                "cookiesPath": None, "sessdataPath": SESSDATA_FILE}
    return {"loginState": "invalid", "mode": "none", "cookiesPath": None}


def cmd_credential(a):
    return emit(_credential())


def cmd_doctor(a):
    url = a.url or ""
    platform = vp.platform_of(url) if url else a.platform
    vid = a.video_id or (vp.detect_video_id(url)[0] if url else None)

    ytdlp = vp.resolve_ytdlp(getattr(a, "ytdlp", None))
    ffmpeg = _find_ffmpeg()
    missing = []
    if not ytdlp:
        missing.append("yt-dlp")
    if not ffmpeg:
        missing.append("ffmpeg")

    cred = _credential()

    # 本地缓存模式：meta.json + transcript.jsonl 已存在 → 本次运行不联网取字幕。
    # 这是"复用已下载内容"，不是"跳过校验"，且只在显式 --allow-cached 时生效。
    cached = False
    if vid:
        vd = os.path.join(a.workdir, vid)
        cached = (os.path.isfile(os.path.join(vd, "meta.json"))
                  and os.path.isfile(os.path.join(vd, "transcript.jsonl")))

    if cred["loginState"] == "valid":
        bili_login = "valid"
    elif cached and a.allow_cached:
        bili_login = "cached"          # 明确标注：走本地缓存，未联网校验登录态
    else:
        bili_login = "invalid"

    if platform == "bilibili" and bili_login == "invalid":
        missing.append("biliLogin")

    return emit({
        "ytdlp": bool(ytdlp),
        "ytdlpPath": ytdlp,
        "ffmpeg": bool(ffmpeg),
        "ffmpegPath": ffmpeg,
        "whisper": _has_whisper(),
        "platform": platform,
        "videoId": vid,
        "biliLogin": bili_login,
        "cached": cached and a.allow_cached,
        "credMode": cred["mode"],
        "missing": missing,
    })


def _find_ffmpeg():
    """跨平台找 ffmpeg：env → PATH → 常见安装位置。"""
    cands = [os.environ.get("VK_FFMPEG"), shutil.which("ffmpeg")]
    cands += [
        "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/bin/ffmpeg",
    ]
    la = os.environ.get("LOCALAPPDATA")
    if la:
        cands.append(os.path.join(
            la, "Microsoft", "WinGet", "Packages",
            "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
            "ffmpeg-9.0.2-full_build", "bin", "ffmpeg.exe"))
    return vp._first_existing(cands)


def _has_whisper():
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False

# ---------------------------------------------------------------- dedupe / verify

def _kb_cards(kbdir):
    """扫描 kb 目录里的卡片元数据：{(video_id, fileName): content_hash}。"""
    out = {}
    if not os.path.isdir(kbdir):
        return out
    for name in sorted(os.listdir(kbdir)):
        if not name.endswith(".md"):
            continue
        p = os.path.join(kbdir, name)
        try:
            txt = open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        mv = re.search(r'^video_id:\s*"([^"]*)"', txt, re.M)
        mh = re.search(r'^content_hash:\s*"(sha256:[0-9a-f]+)"', txt, re.M)
        if mv and mh:
            out[(mv.group(1), name)] = mh.group(1)
    return out


def cmd_dedupe(a):
    card = vp.read_json(a.card)
    vid = card.get("videoId") or a.video_id
    if not vid:
        die("card 里没有 videoId")
    kbdir = os.path.join(a.kb, a.collection)
    os.makedirs(kbdir, exist_ok=True)
    existing = _kb_cards(kbdir)

    queue, skipped, versioned = [], [], []
    for f in card.get("files") or []:
        name = f.get("fileName")
        # 把落盘需要的上下文塞进队列项：upload 子链拿不到主链的 $.intake
        item = dict(f)
        item["kbPath"] = a.kb
        item["collection"] = a.collection
        item["videoId"] = vid
        prev = existing.get((vid, name))
        if prev and prev == f.get("contentHash"):
            skipped.append({"fileName": name, "contentHash": f.get("contentHash"),
                            "reason": "同名且同 hash，已落盘过"})
        elif prev:
            nv = dict(item)
            nv["fileName"] = name[:-3] + "-v2.md" if name.endswith(".md") else name + "-v2"
            versioned.append({"fileName": nv["fileName"], "baseName": name,
                              "from": prev, "to": f.get("contentHash"),
                              "reason": "同 video_id 但内容变了，追加 -v2 只增不删"})
            queue.append(nv)
        else:
            queue.append(item)

    return emit({
        "videoId": vid,
        "kbPath": kbdir,
        "hit": bool(skipped) and not queue,
        "skipped": skipped,
        "versioned": versioned,
        "queue": queue,
        "existingCount": len(existing),
        "queueCount": len(queue),
    })


def cmd_store(a):
    """落盘单张卡片；幂等（同 hash 不重写），冲突走 -v2 后缀（只增不删）。"""
    kbdir = os.path.join(a.kb, a.collection)
    os.makedirs(kbdir, exist_ok=True)
    card = vp.read_json(a.card)
    vid = card.get("videoId") or ""

    name = a.file_name
    # 从 -v2.md 反推原文件名：'-v2.md' 恰好 6 个字符
    base = (name[: -len("-v2.md")] + ".md") if name.endswith("-v2.md") else name
    f = next((x for x in card.get("files") or [] if x.get("fileName") == base), None)
    if not f:
        die(f"card 里没有 {base}（可用：{[x.get('fileName') for x in card.get('files') or []]}）", code=3)

    content = f.get("content") or ""
    dest = os.path.join(kbdir, name)
    if os.path.isfile(dest):
        old = open(dest, encoding="utf-8", errors="replace").read()
        m = re.search(r'^content_hash:\s*"(sha256:[0-9a-f]+)"', old, re.M)
        if m and m.group(1) == f.get("contentHash"):
            return emit({"fileName": name, "ok": True, "unchanged": True,
                         "bytes": len(content.encode("utf-8")), "path": dest})
        name = base[:-3] + "-v2.md"
        dest = os.path.join(kbdir, name)

    with open(dest, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
    return emit({"fileName": name, "ok": True, "bytes": len(content.encode("utf-8")),
                 "path": dest, "videoId": vid, "contentHash": f.get("contentHash")})


def cmd_verify(a):
    kbdir = os.path.join(a.kb, a.collection)
    if not os.path.isdir(kbdir):
        die(f"kb 目录不存在：{kbdir}")
    pat = re.compile(rf"^card-{re.escape(a.video_id)}-p\d+.*\.md$")
    actual = len([n for n in os.listdir(kbdir) if pat.match(n)])
    expected = int(a.expect or 0)
    failures = int(getattr(a, "failures", 0) or 0)
    # 计数达标 + 零失败 才算 ok。只看计数会在"落盘全失败但目录本来就有文件"时假通过。
    return emit({
        "expected": expected,
        "actual": actual,
        "failures": failures,
        "ok": expected > 0 and actual >= expected and failures == 0,
        "kbPath": kbdir,
        "note": "计数达标且 uploadResults.failures==0；只核验文档计数（D9：不核验向量索引）",
    })

# ---------------------------------------------------------------- cards

def cmd_cards(a):
    """把 agent 写好的正文（cards/card-<vid>-pNN.md）组装成 $.card 对象。"""
    vid = a.video_id or die("缺少 --video-id")
    viddir = os.path.join(a.workdir, vid)
    meta_path = os.path.join(viddir, "meta.json")
    if not os.path.isfile(meta_path):
        die(f"缺少 {meta_path}（先跑 meta）")
    meta = vp.read_json(meta_path)
    parts = {p["index"]: p for p in meta.get("parts") or []}

    if not os.path.isdir(a.cards_dir):
        die(f"--cards-dir 不存在：{a.cards_dir}")
    files = vp._iter_card_files(a.cards_dir, vid)
    if not files:
        die(f"{a.cards_dir} 下没有 card-{vid}-pNN.md（正文需由 agent 先写）")

    ns = SimpleNamespace(lang=a.lang, storage_mode=a.storage_mode,
                         retain_raw=False, tags=a.tags)
    out, total_chars = [], 0
    for pidx, path in files:
        raw = open(path, encoding="utf-8").read()
        _, body = vp.split_frontmatter(raw)
        body = body.lstrip("\n")
        if not body.endswith("\n"):
            body += "\n"
        part = parts.get(pidx) or {"index": pidx, "durationSec": 0}
        fm = vp.build_frontmatter(meta, part, ns).replace(
            'content_hash: "PENDING"', f'content_hash: "{vp.content_hash(body)}"')
        content = fm + body
        total_chars += len(body)
        out.append({
            "fileName": f"card-{vid}-p{pidx:02d}.md",
            "title": part.get("title") or f"P{pidx}",
            "content": content,
            "contentHash": vp.content_hash(body),
            "partIndex": pidx,
            "totalParts": len(parts),
        })

    return emit({
        "files": out,
        "summary": f"{len(out)} 张卡片，共 {total_chars} 字",
        "timeline": [{"part": f["partIndex"], "durationSec":
                      (parts.get(f["partIndex"]) or {}).get("durationSec", 0)} for f in out],
        "stats": {"partCount": len(out), "chars": total_chars},
        "videoId": vid,
        "metaPath": meta_path,
    })

# ---------------------------------------------------------------- quality

RE_SENS = [
    ("phone", re.compile(r"1[3-9]\d{9}")),
    ("idcard", re.compile(r"(?<!\d)\d{17}[\dXx]")),
    ("email", re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
    ("bankcard", re.compile(r"(?<!\d)(?:\d[ \-]?){15,18}(?!\d)")),
]
RE_PLACEHOLDER = re.compile(r"_{3,}|TODO|【待填】|＜填|xxxx|……待补")
REQ_KEYS = ["title", "source_url", "video_id", "duration_sec",
            "part_index", "total_parts", "content_hash", "storage_mode"]


def _check_one(content, lo, hi, tol):
    """lo/hi = 该分 P 在**整视频时间轴**上的起止秒（卡片时间戳是全局的）。"""
    issues = []
    fm, body = vp.split_frontmatter(content)
    if fm is None:
        return ["缺 frontmatter"], 0

    for k in REQ_KEYS:
        if not re.search(rf"^{k}:", fm, re.M):
            issues.append(f"frontmatter 缺 {k}")

    if fm is not None:
        m = re.search(r'^content_hash: "(sha256:[0-9a-f]+)"', fm, re.M)
        if m and m.group(1) != vp.content_hash(body):
            issues.append("content_hash 与正文不符")

    tags = [vp.parse_mmss(t) for t in vp.TAG_RE.findall(body)]
    if not tags:
        issues.append("正文没有任何 [mm:ss] 锚点")
    if hi:
        for sec in tags:
            if not (lo - 1 <= sec <= hi + 1):
                issues.append(f"[{vp.mmss(sec)[1:-1]}] 超出本 P 时间范围 "
                              f"[{int(lo)},{int(hi)}]")
    core = vp._section(body, "核心要点")
    if core:
        prev = None
        for t in vp.TAG_RE.findall(core):
            s = vp.parse_mmss(t)
            if prev is not None and s < prev:
                issues.append(f"核心要点内 [{t}] 非升序")
            prev = s

    nchars = len(body)
    if nchars < 500:
        issues.append(f"正文仅 {nchars} 字（<500）")
    if nchars > 50000:
        issues.append(f"正文 {nchars} 字（>50000，需按章节拆 part）")

    for name, rx in RE_SENS:
        if rx.search(body):
            issues.append(f"命中敏感信息：{name}")
    if RE_PLACEHOLDER.search(body):
        issues.append("残留占位符（___ / TODO 等）")
    return issues, nchars


def cmd_quality(a):
    card = vp.read_json(a.card) if a.card else None
    if not card:
        die("缺少 --card <$.card JSON 文件>")
    files = card.get("files") or []
    if not files:
        die("card.files 为空，无可校验卡片")

    ranges = {}
    if a.meta and os.path.isfile(a.meta):
        meta = vp.read_json(a.meta)
        for p in meta.get("parts") or []:
            off = p.get("offsetSec") or 0
            ranges[p["index"]] = (off, off + (p.get("durationSec") or 0))

    all_issues, per, total_chars = [], {}, 0
    for f in files:
        content = f.get("content") or ""
        lo, hi = ranges.get(f.get("partIndex"), (0, 0))
        issues, nchars = _check_one(content, lo, hi, a.tol)
        total_chars += nchars
        per[f.get("fileName")] = {"chars": nchars, "issues": issues}
        all_issues += [f"{f.get('fileName')}: {i}" for i in issues]

    stats = {
        "files": len(files),
        "chars": total_chars,
        "issues": len(all_issues),
    }
    return emit({
        "ok": not all_issues,
        "checks": {
            "frontmatter": not any("frontmatter" in i for i in all_issues),
            "timestamps": not any("mm:ss" in i or "升序" in i or "超出时长" in i
                                  for i in all_issues),
            "charCount": not any("字（" in i for i in all_issues),
            "sensitive": not any("敏感信息" in i for i in all_issues),
            "placeholder": not any("占位符" in i for i in all_issues),
        },
        "stats": stats,
        "issues": all_issues[:50],
        "perFile": per,
        "reason": "五项校验全通过" if not all_issues else f"{len(all_issues)} 处问题",
    })

# ---------------------------------------------------------------- outline

def cmd_outline(a):
    """把 $.card.files 的核心要点灌进大纲的「- 笔记区」占位。"""
    card = vp.read_json(a.card) if a.card else None
    if not card:
        die("缺少 --card <$.card JSON 文件>")
    if not os.path.isfile(a.outline):
        die(f"大纲文件不存在：{a.outline}")

    outline = open(a.outline, encoding="utf-8").read()
    vid = card.get("videoId") or ""
    filled, missing = 0, []

    for f in card.get("files") or []:
        pidx = f.get("partIndex")
        _, body = vp.split_frontmatter(f.get("content") or "")
        core = vp._section(body, "核心要点")
        if not core:
            missing.append(f"P{pidx}: 无核心要点")
            continue
        bullets = [ln.rstrip() for ln in core.splitlines() if ln.strip().startswith("- ")]
        if not bullets:
            missing.append(f"P{pidx}: 核心要点无条目")
            continue

        block = [f"- 笔记区（已填充，详见 [{f.get('fileName')}](kb/"
                 f"{a.collection}/{f.get('fileName')})）"] + ["  " + b for b in bullets]

        head = re.compile(rf"^##\s*P{pidx}\s*·.*$", re.M)
        mh = head.search(outline)
        if not mh:
            missing.append(f"P{pidx}: 大纲无对应小节")
            continue
        nxt = re.search(r"^##\s", outline[mh.end():], re.M)
        seg_end = mh.end() + (nxt.start() if nxt else len(outline))
        segment = outline[mh.start():seg_end]

        repl = re.compile(r"^- 笔记区.*?(?=(?:\n\s*\n|\n---|\n##\s)|\Z)", re.M | re.S)
        if not repl.search(segment):
            missing.append(f"P{pidx}: 小节内无「- 笔记区」占位")
            continue
        outline = (outline[:mh.start()] + repl.sub("\n".join(block), segment, count=1)
                   + outline[seg_end:])
        filled += 1

    if not a.dry_run:
        with open(a.outline, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(outline)

    return emit({
        "ok": filled > 0,
        "updated": filled,
        "path": a.outline,
        "written": not a.dry_run,
        "skipped": missing,
        "videoId": vid,
    })

# ---------------------------------------------------------------- CLI

def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(prog="vk_chain",
                                 description="AJTC 链的确定性内核（每命令输出一个 JSON）")
    ap.add_argument("--workdir", default="runs")
    ap.add_argument("--out", help="额外把 JSON 落一份到该文件（无 BOM）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("meta")
    m.add_argument("--url", required=True)
    m.add_argument("--video-id")
    m.add_argument("--cookies")
    m.add_argument("--ytdlp")
    m.add_argument("--refresh", action="store_true", help="忽略缓存重新抓")
    m.set_defaults(func=cmd_meta)

    t = sub.add_parser("transcript")
    t.add_argument("--url", required=True)
    t.add_argument("--video-id")
    t.add_argument("--cookies")
    t.add_argument("--ytdlp")
    t.add_argument("--lang", default="zh-CN")
    t.add_argument("--sub-langs", default="ai-zh,zh-Hans,zh-CN")
    t.add_argument("--refresh", action="store_true")
    t.set_defaults(func=cmd_transcript)

    dd = sub.add_parser("dedupe")
    dd.add_argument("--card", required=True)
    dd.add_argument("--video-id")
    dd.add_argument("--kb", default="kb")
    dd.add_argument("--collection", default="bilibili")
    dd.set_defaults(func=cmd_dedupe)

    st = sub.add_parser("store")
    st.add_argument("--card", required=True)
    st.add_argument("--file-name", required=True)
    st.add_argument("--kb", default="kb")
    st.add_argument("--collection", default="bilibili")
    st.set_defaults(func=cmd_store)

    vf = sub.add_parser("verify")
    vf.add_argument("--video-id", required=True)
    vf.add_argument("--kb", default="kb")
    vf.add_argument("--collection", default="bilibili")
    vf.add_argument("--expect", default="0")
    vf.add_argument("--failures", default="0", help="uploadResults.failures.length，必须为 0")
    vf.set_defaults(func=cmd_verify)

    d = sub.add_parser("doctor")
    d.add_argument("--url", default="")
    d.add_argument("--platform", default="bilibili")
    d.add_argument("--ytdlp")
    d.add_argument("--video-id")
    d.add_argument("--allow-cached", action="store_true",
                   help="已有 meta.json+transcript.jsonl 时允许走本地缓存（不联网）")
    d.set_defaults(func=cmd_doctor)

    cr = sub.add_parser("credential")
    cr.set_defaults(func=cmd_credential)

    c = sub.add_parser("cards")
    c.add_argument("--video-id", required=True)
    c.add_argument("--cards-dir", required=True)
    c.add_argument("--lang", default="zh-CN")
    c.add_argument("--tags", default="")
    c.add_argument("--storage-mode", default="refined")
    c.set_defaults(func=cmd_cards)

    q = sub.add_parser("quality")
    q.add_argument("--card", required=True)
    q.add_argument("--meta")
    q.add_argument("--tol", type=float, default=5.0)
    q.set_defaults(func=cmd_quality)

    o = sub.add_parser("outline")
    o.add_argument("--card", required=True)
    o.add_argument("--outline", required=True)
    o.add_argument("--collection", default="bilibili")
    o.add_argument("--dry-run", action="store_true")
    o.set_defaults(func=cmd_outline)

    a = ap.parse_args(argv)
    os.makedirs(a.workdir, exist_ok=True)
    if getattr(a, "out", None):
        emit.out_path = a.out
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
