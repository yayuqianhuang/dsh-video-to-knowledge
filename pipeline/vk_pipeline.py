#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vk_pipeline.py — 视频 → 知识卡 可复用流水线（单入口）

把原先散落在 runs/ 的一次性脚本收成一个带子命令的流水线：

    fetch     抓字幕（yt-dlp + B站登录 cookie）→ 落 subs/*.srt + meta.json
    build     SRT → transcript.jsonl（多 P 时间偏移合并）→ 清洗 → 切块
              → 分 P 素材包 by_p/pNN.txt + 白名单 → manifest.json
    finalize  卡片正文 → 校验 [mm:ss] 白名单 → 注入 frontmatter/content_hash
              → 落盘 kb/<collection>/ → 重建索引
    check     校验已落盘卡片（frontmatter 必填 / 时间戳白名单 / 升序）
    outline   把卡片「核心要点」灌进大纲对应 P 段的「笔记区」
    all       fetch + build（一条命令跑到素材就绪）

分工（与 AJTC 链的 agentStep 语义一致）：
    机械步骤（抓取/转换/清洗/切块/校验/落盘/索引/大纲）全部由本脚本完成，0 token；
    「写卡片正文」是唯一需要模型的步骤，由 agent 或 LLM 完成，产物交给 finalize。

用法示例：
    # 1) 抓字幕（cookie 文件等同账号密码，用完即删，绝不进日志）
    python scripts/vk_pipeline.py fetch --url https://www.bilibili.com/video/BV1RK556vESf \
        --cookies D:/tmp/cookies.txt

    # 2) 生成素材包
    python scripts/vk_pipeline.py build --video-id BV1RK556vESf

    # 3) agent 读 runs/<vid>/by_p/pNN.txt 写正文到 cards/（仅正文，不含 frontmatter）
    #    文件名约定 card-<videoId>-p<NN>.md

    # 4) 校验 + 落盘 + 索引
    python scripts/vk_pipeline.py finalize --video-id BV1RK556vESf --cards-dir cards \
        --kb kb --collection bilibili

    # 5) 灌大纲
    python scripts/vk_pipeline.py outline --video-id BV1RK556vESf \
        --kb kb --collection bilibili --outline ERP项目实战软件测试_学习大纲.md

退出码：0 成功；1 一般错误；2 前置条件不满足（依赖/凭证/文件缺失）；
        3 校验未通过（check/finalize 发现时间戳越界或 frontmatter 不全）。
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime

# ---------------------------------------------------------------- 路径解析

def _first_existing(paths):
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return None


def resolve_ytdlp(explicit=None):
    """按 --ytdlp > $VK_YTDLP > PATH > 常见安装位置 的顺序找 yt-dlp。"""
    cands = [explicit, os.environ.get("VK_YTDLP"), shutil.which("yt-dlp")]
    home = os.path.expanduser("~")
    # POSIX 常见位置
    cands += [
        "/usr/local/bin/yt-dlp", "/opt/homebrew/bin/yt-dlp",
        os.path.join(home, ".local", "bin", "yt-dlp"),
    ]
    # Windows 常见位置（%APPDATA% / %LOCALAPPDATA% 不存在时自动跳过）
    for env_key in ("APPDATA", "LOCALAPPDATA"):
        base = os.environ.get(env_key)
        if not base:
            continue
        for pyver in ("Python313", "Python312", "Python311"):
            cands.append(os.path.join(base, "Python", pyver, "Scripts", "yt-dlp.exe"))
            cands.append(os.path.join(base, "Programs", "Python", pyver, "Scripts", "yt-dlp.exe"))
    return _first_existing(cands)


def resolve_cleaner(explicit=None):
    """清洗脚本：--cleaner > $VK_CLEANER > 同目录 > AJTC 仓库默认位置。"""
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [
        explicit,
        os.environ.get("VK_CLEANER"),
        os.path.join(here, "clean_transcript.py"),
    ]
    return _first_existing(cands)


def _decode_out(buf):
    """子进程字节输出 → str：优先 UTF-8，退到 cp936（zh-CN Windows 默认），最后兜底替换。

    不能只用 `text=True, encoding="utf-8"`：yt-dlp 自身是 Python 脚本，在中文
    Windows 上默认按 cp936 写 stdout，父进程按 utf-8 解会把中文标题变成 U+FFFD，
    而且 U+FFFD 不可逆——脏标题会一路写进 meta.json 与卡片 frontmatter。
    """
    if not buf:
        return ""
    for enc in ("utf-8", "cp936"):
        try:
            return buf.decode(enc)
        except UnicodeDecodeError:
            continue
    return buf.decode("utf-8", errors="replace")


def run_cmd(args, quiet=True):
    """执行外部命令，返回 (code, stdout, stderr)。不打印任何含凭证的内容。"""
    # 强制子进程按 UTF-8 输出（PYTHONUTF8 对 yt-dlp 这类 Python 子进程生效），
    # 父进程再按 utf-8 → cp936 的顺序解码，两边编码不再错配。
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.run(args, capture_output=True, env=env)
    out = _decode_out(proc.stdout)
    err = _decode_out(proc.stderr)
    if not quiet and out:
        sys.stderr.write(out)
    return proc.returncode, out, err

# ---------------------------------------------------------------- 小工具

RE_BV = re.compile(r"(BV[0-9A-Za-z]{10})")
RE_YT = re.compile(r"(?:v=|youtu\.be/|/shorts/)([0-9A-Za-z_-]{11})")


def detect_video_id(url):
    m = RE_BV.search(url)
    if m:
        return m.group(1), "bilibili"
    m = RE_YT.search(url)
    if m:
        return m.group(1), "youtube"
    return None, None


def platform_of(url):
    if "bilibili.com" in url or "b23.tv" in url:
        return "bilibili"
    if "youtube.com" in url or "youtu.be" in url:
        return "youtube"
    return "unknown"


def mmss(sec):
    sec = int(sec)
    return f"[{sec // 60:02d}:{sec % 60:02d}]"


def parse_mmss(tag):
    """把 01:24 或 1:02:03 解析成秒。"""
    parts = [int(x) for x in tag.split(":")]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    raise ValueError(f"无法解析时间戳: {tag}")


RE_TS = re.compile(r"(\d{1,2}:\d{2}:\d{2},\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2},\d{1,3})")
RE_NUM = re.compile(r"^\d+$")


def ts2sec(ts):
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s.replace(",", "."))


def parse_srt(path):
    """逐行状态机解析 SRT，返回 [(startSec, endSec, text)]。不依赖空行分隔。"""
    segments = []
    cur = None
    with open(path, encoding="utf-8-sig", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            m = RE_TS.match(line)
            if m:
                if cur and cur.get("start") is not None:
                    segments.append((cur["start"], cur["end"], cur["text"].strip()))
                cur = {"start": m.group(1), "end": m.group(2), "text": ""}
            elif RE_NUM.match(line):
                continue
            elif cur is not None:
                cur["text"] += line + " "
    if cur and cur.get("start") is not None:
        segments.append((cur["start"], cur["end"], cur["text"].strip()))

    out = []
    for s, e, t in segments:
        if not t:
            continue
        out.append((ts2sec(s), ts2sec(e), t))
    return out


def p_index_from_name(name):
    r"""从文件名前缀取分 P 序号：支持 01_xxx.srt / 01.xxx.srt / card-<vid>-p01.md

    单 P 视频有一个坑：yt-dlp 的 %(playlist_index)02d 会渲染成字面量 "NA"，
    产出 NA_<title>.ai-zh.srt。旧实现只认 ^\d{2}，于是这类文件被丢弃，
    表现为"字幕明明下载了却报 NO_TRANSCRIPT"。这里把 NA 前缀视为第 1 个 P。
    """
    m = re.match(r"^(\d{2})[_.\s]", name)
    if m:
        return int(m.group(1))
    m = re.match(r"^NA[_.\s]", name, re.I)
    if m:
        return 1
    m = re.search(r"-p(\d{2})\.md$", name)
    if m:
        return int(m.group(1))
    return None


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)


def read_json(path):
    # utf-8-sig：容忍 PowerShell `>` 重定向/记事本另存产生的 BOM
    with open(path, encoding="utf-8-sig") as fh:
        return json.load(fh)


def require(cond, msg, code=2):
    if not cond:
        sys.stderr.write(f"ERROR: {msg}\n")
        sys.exit(code)

# ---------------------------------------------------------------- fetch

def cmd_fetch(args):
    url = args.url
    require(bool(url), "缺少 --url")
    platform = platform_of(url)
    require(platform != "unknown",
            f"无法识别平台（仅支持 bilibili / youtube）：{url}")

    vid, _ = detect_video_id(url)
    if args.video_id:
        vid = args.video_id
    require(bool(vid), "无法从 URL 解析视频号，请用 --video-id 显式指定")

    ytdlp = resolve_ytdlp(args.ytdlp)
    require(bool(ytdlp),
            "找不到 yt-dlp。请安装（pip install yt-dlp）或用 --ytdlp / $VK_YTDLP 指定。")

    cookies = args.cookies or os.environ.get("BILI_COOKIES") or os.environ.get("VK_COOKIES")
    if platform == "bilibili":
        require(bool(cookies),
                "B 站需要登录态才能拿到字幕。请用 --cookies <cookie文件> 或 $BILI_COOKIES 指定。")
        require(os.path.isfile(cookies), f"cookie 文件不存在：{cookies}")

    viddir = os.path.join(args.workdir, vid)
    subsdir = os.path.join(viddir, "subs")
    os.makedirs(subsdir, exist_ok=True)

    common = [ytdlp, "--no-warnings"]
    if cookies:
        common += ["--cookies", cookies]

    # ---- 1) 取分 P 元数据（标题/时长） ----
    print(f"[fetch] 读取元数据 …", flush=True)
    fmt = "%(playlist_index)s\t%(duration)s\t%(playlist_title)s\t%(title)s"
    code, out, err = run_cmd(common + ["--print", fmt, url])
    require(code == 0, f"yt-dlp 元数据抓取失败：\n{(err or out)[-800:]}")

    parts = []
    for line in out.splitlines():
        fields = line.rstrip("\n").split("\t")
        if len(fields) < 4:
            continue
        idx_s, dur_s, ptitle, title = fields[0], fields[1], fields[2], fields[3]
        try:
            dur = float(dur_s)
        except ValueError:
            continue  # 时长缺失的条目直接跳过（拿不到偏移就没法合并）
        try:
            idx = int(idx_s)
        except ValueError:
            idx = len(parts) + 1
        parts.append({"index": idx, "durationSec": dur,
                      "playlistTitle": None if ptitle in ("NA", "") else ptitle,
                      "title": None if title in ("NA", "") else title})

    require(bool(parts), "没有解析到任何分 P 元数据（视频可能已删除或受限）")

    parts.sort(key=lambda p: p["index"])
    offset = 0.0
    for p in parts:
        p["offsetSec"] = round(offset, 3)
        offset += p["durationSec"]

    meta = {
        "videoId": vid,
        "platform": platform,
        "url": url,
        "title": parts[0].get("playlistTitle") or parts[0].get("title") or vid,
        "uploader": args.uploader or "",
        "publishedAt": args.published_at or "unknown",
        "lang": args.lang,
        "totalDurationSec": round(offset, 3),
        "parts": parts,
    }

    # ---- 2) 下载字幕（不下载视频） ----
    print(f"[fetch] 抓取字幕（{len(parts)} 个分 P，语言 {args.sub_langs}）…", flush=True)
    outtmpl = os.path.join(subsdir, "%(playlist_index)02d_%(title)s.%(ext)s")
    sub_cmd = common + [
        "--write-subs", "--write-auto-subs",
        "--sub-langs", args.sub_langs,
        "--skip-download", "--no-overwrites",
        "-o", outtmpl, url,
    ]
    code, out, err = run_cmd(sub_cmd)
    if code != 0:
        tail = (err or out)[-1200:]
        sys.stderr.write(f"WARN: yt-dlp 退出码 {code}，字幕可能只拿到一部分：\n{tail}\n")

    srts = sorted(f for f in os.listdir(subsdir) if f.lower().endswith(".srt"))
    require(bool(srts),
            "没有下载到任何 .srt 字幕。常见原因：① cookie 失效 ② 该视频无 AI 字幕 "
            "③ 语言代码不对（可试 --sub-langs ai-zh,zh-Hans,zh-CN）。")

    write_json(os.path.join(viddir, "meta.json"), meta)
    print(f"[fetch] OK  视频 {len(srts)} 个字幕文件 / {len(parts)} 个分 P")
    print(f"[fetch] 元数据 -> {os.path.join(viddir, 'meta.json')}")
    print(f"[fetch] 字幕   -> {subsdir}")
    print("[fetch] 提醒：cookie 文件等同账号密码，用完请立即删除。")
    return 0

# ---------------------------------------------------------------- build

def _load_or_synth_meta(viddir, vid, durations=None, url=None):
    meta_path = os.path.join(viddir, "meta.json")
    if os.path.isfile(meta_path):
        return read_json(meta_path)

    # 没有 meta.json：用 --durations 兜底合成（便于对历史 runs 复用/回归）
    srt_names = sorted(
        f for f in os.listdir(viddir) if f.lower().endswith(".srt")
    ) if os.path.isdir(viddir) else []
    subsdir = os.path.join(viddir, "subs")
    if os.path.isdir(subsdir):
        srt_names += sorted(f for f in os.listdir(subsdir) if f.lower().endswith(".srt"))

    idxs = sorted({i for i in (p_index_from_name(n) for n in srt_names) if i})
    require(bool(idxs), f"{viddir} 下找不到字幕文件（*.srt）")

    if durations:
        durs = [float(x) for x in str(durations).split(",") if x.strip()]
        require(len(durs) == len(idxs),
                f"--durations 给了 {len(durs)} 个值，但字幕有 {len(idxs)} 个分 P")
    else:
        durs = [0.0] * len(idxs)

    parts, offset = [], 0.0
    for n, idx in enumerate(idxs):
        parts.append({"index": idx, "durationSec": durs[n],
                      "offsetSec": round(offset, 3), "title": f"P{idx}"})
        offset += durs[n]

    return {
        "videoId": vid, "platform": platform_of(url or ""), "url": url or "",
        "title": vid, "uploader": "", "publishedAt": "unknown",
        "lang": "ai-zh", "totalDurationSec": round(offset, 3),
        "parts": parts, "_synthesized": True,
    }


def _find_srts(viddir):
    """在 viddir 与 viddir/subs 两处找 srt，返回 {pIndex: path}。"""
    found = {}
    # viddir/manual 是给"手动下载 srt"留的兜底位置
    for d in (viddir, os.path.join(viddir, "subs"), os.path.join(viddir, "manual")):
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.lower().endswith(".srt"):
                continue
            # 优先 ai-zh 轨道，跳过重复的 _pNA 之类
            if "_pna" in name.lower():
                continue
            idx = p_index_from_name(name)
            if idx is None:
                continue
            if idx in found:
                prev = os.path.basename(found[idx])
                prev_na = prev.upper().startswith("NA")
                new_na = name.upper().startswith("NA")
                # 同一索引下：编号名（01_）优先于 NA_ 名
                if new_na and not prev_na:
                    continue
                # 别用非 ai-zh 轨道覆盖已找到的 ai-zh 轨道
                if "ai-zh" not in name.lower() and "ai-zh" in prev.lower():
                    continue
            found[idx] = os.path.join(d, name)

    # 兜底：一个索引都没解析出来，但确实存在 srt（如手动的 <videoId>.ai-zh.srt），
    # 单 P 视频就把它当作 P1
    if not found:
        loose = []
        for d in (viddir, os.path.join(viddir, "subs"), os.path.join(viddir, "manual")):
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                if name.lower().endswith(".srt") and "_pna" not in name.lower():
                    loose.append(os.path.join(d, name))
        if len(loose) == 1:
            found[1] = loose[0]
    return found


def cmd_build(args):
    vid = args.video_id
    require(bool(vid), "缺少 --video-id")
    viddir = os.path.join(args.workdir, vid)
    require(os.path.isdir(viddir), f"目录不存在：{viddir}（先跑 fetch）")

    meta = _load_or_synth_meta(viddir, vid, args.durations, args.url)
    parts = meta["parts"]
    srts = _find_srts(viddir)
    require(bool(srts), f"{viddir} 下找不到分 P 字幕（*.srt）")

    missing = [p["index"] for p in parts if p["index"] not in srts]
    if missing:
        sys.stderr.write(f"WARN: 分 P {missing} 没有字幕文件，将跳过。\n")

    # ---- SRT → transcript.jsonl（按 P 偏移合并到整视频时间轴） ----
    records = []
    part_stats = []
    for p in sorted(parts, key=lambda x: x["index"]):
        idx = p["index"]
        if idx not in srts:
            continue
        segs = parse_srt(srts[idx])
        off = p.get("offsetSec", 0)
        kept = 0
        for s, e, text in segs:
            gs, ge = s + off, e + off
            records.append({
                "idx": len(records),
                "startSec": int(round(gs)),
                "endSec": int(round(ge)),
                "text": text,
            })
            kept += 1
        part_stats.append({"index": idx, "segments": kept,
                           "offsetSec": off, "durationSec": p.get("durationSec", 0),
                           "srt": os.path.basename(srts[idx])})

    require(bool(records), "所有分 P 都解析出 0 段，字幕格式可能不受支持")

    transcript_path = os.path.join(viddir, "transcript.jsonl")
    with open(transcript_path, "w", encoding="utf-8", newline="\n") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[build] transcript.jsonl: {len(records)} 段 -> {transcript_path}")

    # ---- 清洗 + 切块（复用链里的 clean_transcript.py） ----
    cleaner = resolve_cleaner(args.cleaner)
    require(bool(cleaner),
            "找不到 clean_transcript.py。用 --cleaner 或 $VK_CLEANER 指定。")
    clean_path = os.path.join(viddir, "clean.jsonl")
    stats_path = os.path.join(viddir, "clean.stats.json")
    code, out, err = run_cmd([
        args.python, cleaner,
        "--input", transcript_path,
        "--output", clean_path,
        "--stats", stats_path,
    ])
    if code == 2:
        sys.stderr.write(err or out)
        sys.stderr.write("ERROR: 清洗后字数 < 300（TRANSCRIPT_TOO_SHORT），不产出卡片。\n")
        return 2
    require(code == 0, f"清洗脚本失败（exit {code}）：\n{(err or out)[-800:]}")

    stats = read_json(stats_path)
    print(f"[build] 清洗: {stats.get('chars')} 字 / {stats.get('segmentCount')} 段 / "
          f"{stats.get('chunkCount')} 块  (pii={stats.get('piiHits')}, "
          f"merged={stats.get('mergedCount')})")

    # ---- 分 P 素材包 + 时间戳白名单 ----
    byp = os.path.join(viddir, "by_p")
    os.makedirs(byp, exist_ok=True)
    clean_segs = [json.loads(l) for l in open(clean_path, encoding="utf-8") if l.strip()]

    bounds = []
    for p in sorted(parts, key=lambda x: x["index"]):
        start = p.get("offsetSec", 0)
        end = start + (p.get("durationSec") or 0)
        bounds.append((p["index"], start, end))

    for idx, start, end in bounds:
        if not end:
            segs = [s for s in clean_segs if s["startSec"] >= start] if idx == bounds[-1][0] \
                else [s for s in clean_segs if s["startSec"] >= start and s["startSec"] <
                      next(b[1] for b in bounds if b[0] > idx)]
        else:
            segs = [s for s in clean_segs if start <= s["startSec"] < end]
        segs.sort(key=lambda s: s["startSec"])

        txt = "\n".join(f"{mmss(s['startSec'])} {s['text']}" for s in segs)
        with open(os.path.join(byp, f"p{idx:02d}.txt"), "w",
                  encoding="utf-8", newline="\n") as fh:
            fh.write(txt + ("\n" if txt else ""))

        whitelist = {"partIndex": idx, "startSec": start, "endSec": end,
                     "segmentStarts": sorted({s["startSec"] for s in segs})}
        write_json(os.path.join(byp, f"p{idx:02d}.whitelist.json"), whitelist)
        print(f"[build]   P{idx}: {len(segs)} 段, {len(txt)} 字  -> by_p/p{idx:02d}.txt")

    manifest = {
        "videoId": vid,
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "meta": meta,
        "parts": part_stats,
        "clean": stats,
        "paths": {
            "transcript": transcript_path,
            "clean": clean_path,
            "stats": stats_path,
            "byP": byp,
        },
        "nextStep": "让 agent/LLM 读 by_p/pNN.txt 写卡片正文到 cards/card-<videoId>-pNN.md"
                    "（只写正文，frontmatter 由 finalize 注入），再跑 finalize。",
    }
    write_json(os.path.join(viddir, "manifest.json"), manifest)
    print(f"[build] manifest -> {os.path.join(viddir, 'manifest.json')}")
    print("[build] 素材就绪。下一步：写卡片正文 → finalize")
    return 0

# ---------------------------------------------------------------- finalize / check

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
TAG_RE = re.compile(r"\[(\d{1,2}:\d{2}(?::\d{2})?)\]")


def split_frontmatter(text):
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None, text
    return m.group(0), text[m.end():]


def content_hash(body):
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]


def build_frontmatter(meta, part, args):
    dur = part.get("durationSec") or 0
    idx = part["index"]
    total = len(meta["parts"])

    # 分 P 标题若已带「P<n>」前缀先剥掉，避免拼成 "P1 P1 xxx"
    part_title = (part.get("title") or "").strip()
    part_title = re.sub(rf"^P{idx}[\s·:：\-_]*", "", part_title, flags=re.I).strip()
    base = meta.get("title") or meta["videoId"]
    if total > 1:
        title = f"{base} · P{idx}" + (f" {part_title}" if part_title else "")
    else:
        title = part_title or base
    src = meta.get("url") or ""
    if "?" in src:
        src = src.split("?")[0]
    src = f"{src}?p={idx}" if total > 1 else src

    tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()]
    lines = [
        "---",
        f"title: {json.dumps(title, ensure_ascii=False)}",
        f"source_platform: {meta.get('platform') or 'bilibili'}",
        f"source_url: {json.dumps(src, ensure_ascii=False)}",
        f"video_id: {json.dumps(meta['videoId'], ensure_ascii=False)}",
        f"uploader: {json.dumps(meta.get('uploader') or '', ensure_ascii=False)}",
        f"published_at: {json.dumps(str(meta.get('publishedAt') or 'unknown'), ensure_ascii=False)}",
        f"duration_sec: {int(round(dur))}",
        f"transcript_source: platform",
        f"lang: {args.lang}",
        f"compiled_at: {json.dumps(datetime.now().astimezone().isoformat(timespec='seconds'), ensure_ascii=False)}",
        "compiler: gen.video-to-knowledge@0.1.0",
        f'content_hash: "PENDING"',
        f"part_index: {idx}",
        f"total_parts: {total}",
        f"storage_mode: {args.storage_mode}",
        f"retain_raw: {'true' if args.retain_raw else 'false'}",
        f"tags: {json.dumps(tags, ensure_ascii=False)}",
        "---",
        "",
    ]
    return "\n".join(lines)


def _section(body, name):
    """取正文里 `## <name>` 到下一个 h2 之间的内容；没有则返回 None。"""
    m = re.search(rf"^##\s*{re.escape(name)}\s*$(.*?)(?=^##\s|\Z)", body, re.M | re.S)
    return m.group(1) if m else None


def check_card(body, whitelist, tol):
    """返回 (问题列表, 最大时间偏差秒数)。

    校验分三层，避免假阳性：
      1) 范围：文中每个 [mm:ss] 必须落在本 P 的 [startSec, endSec] 内（±1s）；
      2) 白名单：每个 [mm:ss] 必须贴近某个真实字幕段起点（容差 tol，默认 5s）；
      3) 升序：**只在「## 核心要点」段内**要求升序——其他小节（关键概念/存疑/
         可执行清单）按主题引用，天然可能引用更早的时间点，不应判错。
    """
    problems = []
    starts = whitelist.get("segmentStarts") or []
    lo, hi = whitelist.get("startSec"), whitelist.get("endSec")
    tags = TAG_RE.findall(body)
    if not tags:
        return ["正文没有任何 [mm:ss] 锚点"], 0.0

    worst = 0.0
    for tag in tags:
        sec = parse_mmss(tag)
        if hi and not (lo - 1 <= sec <= hi + 1):
            problems.append(f"[{tag}] 落在本 P 时间范围 [{lo},{hi}] 之外")
        if starts:
            d = min(abs(sec - s) for s in starts)
            worst = max(worst, d)
            if d > tol:
                problems.append(f"[{tag}] 距最近的原始字幕段 {d:.0f}s，超过容差 {tol}s")

    # 升序：只查核心要点（去重相邻重复，避免同一时间戳被列两次就报错）
    core = _section(body, "核心要点")
    if core:
        prev = None
        for tag in TAG_RE.findall(core):
            sec = parse_mmss(tag)
            if prev is not None and sec < prev:
                problems.append(f"核心要点内 [{tag}] 非升序（前一条 {mmss(prev)}）")
            prev = sec

    return problems, worst


def _iter_card_files(cards_dir, vid):
    pat = re.compile(rf"^card-{re.escape(vid)}-p(\d{{2}})\.md$")
    out = []
    for name in sorted(os.listdir(cards_dir)):
        m = pat.match(name)
        if m:
            out.append((int(m.group(1)), os.path.join(cards_dir, name)))
    return out


def cmd_finalize(args):
    vid = args.video_id
    viddir = os.path.join(args.workdir, vid)
    require(os.path.isdir(viddir), f"目录不存在：{viddir}（先跑 build）")
    meta = read_json(os.path.join(viddir, "meta.json")) \
        if os.path.isfile(os.path.join(viddir, "meta.json")) \
        else _load_or_synth_meta(viddir, vid, args.durations, args.url)
    parts_by_idx = {p["index"]: p for p in meta["parts"]}

    require(bool(args.cards_dir) and os.path.isdir(args.cards_dir),
            f"--cards-dir 不存在：{args.cards_dir}")
    cards = _iter_card_files(args.cards_dir, vid)
    require(bool(cards), f"{args.cards_dir} 下没有 card-{vid}-pNN.md")

    kbdir = os.path.join(args.kb, args.collection)
    os.makedirs(kbdir, exist_ok=True)

    problems_total = 0
    written = []
    for pidx, path in cards:
        body = open(path, encoding="utf-8").read()
        _, body = split_frontmatter(body)          # 丢掉可能存在的旧 frontmatter
        body = body.lstrip("\n")
        if not body.endswith("\n"):
            body += "\n"

        wl_path = os.path.join(viddir, "by_p", f"p{pidx:02d}.whitelist.json")
        if os.path.isfile(wl_path):
            problems, worst = check_card(body, read_json(wl_path), args.tol)
            if problems:
                problems_total += len(problems)
                sys.stderr.write(f"WARN: p{pidx:02d} 有 {len(problems)} 处时间戳问题"
                                 f"（最大偏差 {worst:.0f}s）：\n")
                for p in problems[:5]:
                    sys.stderr.write(f"      - {p}\n")
        part = parts_by_idx.get(pidx) or {"index": pidx, "durationSec": 0}

        fm = build_frontmatter(meta, part, args)
        fm = fm.replace('content_hash: "PENDING"',
                        f'content_hash: "{content_hash(body)}"')
        dest = os.path.join(kbdir, f"card-{vid}-p{pidx:02d}.md")
        with open(dest, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(fm + body)
        written.append((pidx, os.path.basename(dest), content_hash(body), part))
        print(f"[finalize] P{pidx} -> {dest}")

    # 索引
    idx_lines = [f"# 知识卡片索引 · {vid}", ""]
    if meta.get("url"):
        idx_lines.append(f"> 视频：[{meta.get('title') or vid}]({meta['url']})")
    total_min = int((meta.get("totalDurationSec") or 0) // 60)
    total_sec = int((meta.get("totalDurationSec") or 0) % 60)
    idx_lines.append(f"> UP：{meta.get('uploader') or '—'} · 总时长 "
                     f"{total_min}:{total_sec:02d} · 字幕来源：平台字幕")
    idx_lines += ["", "## 分 P 卡片", "",
                  "| Part | 文件 | 时长 | content_hash |", "|---|---|---|---|"]
    for pidx, name, h, part in written:
        idx_lines.append(f"| P{pidx} | [{name}]({name}) | "
                         f"{int(round(part.get('durationSec') or 0))}s | {h[:16]} |")
    idx_path = os.path.join(kbdir, f"index-{vid}.md")
    with open(idx_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(idx_lines) + "\n")
    print(f"[finalize] 索引 -> {idx_path}")

    if problems_total and args.strict:
        sys.stderr.write(f"ERROR: --strict 下校验未通过（{problems_total} 处问题）\n")
        return 3
    return 0


def cmd_check(args):
    vid = args.video_id
    viddir = os.path.join(args.workdir, vid)
    kbdir = os.path.join(args.kb, args.collection)
    require(os.path.isdir(kbdir), f"kb 目录不存在：{kbdir}")

    cards = _iter_card_files(kbdir, vid)
    require(bool(cards), f"{kbdir} 下没有 card-{vid}-pNN.md")

    required = ["title", "source_url", "video_id", "duration_sec", "part_index",
                "total_parts", "content_hash", "storage_mode"]
    bad = 0
    for pidx, path in cards:
        text = open(path, encoding="utf-8").read()
        fm_raw, body = split_frontmatter(text)
        issues = []
        if fm_raw is None:
            issues.append("缺 frontmatter")
        else:
            for key in required:
                if not re.search(rf"^{key}:", fm_raw, re.M):
                    issues.append(f"frontmatter 缺 {key}")
            m = re.search(r'^content_hash: "(sha256:[0-9a-f]+)"', fm_raw, re.M)
            if m and m.group(1) != content_hash(body):
                issues.append("content_hash 与正文不符（正文被改过？）")

        wl_path = os.path.join(viddir, "by_p", f"p{pidx:02d}.whitelist.json")
        worst = None
        if os.path.isfile(wl_path):
            p, worst = check_card(body, read_json(wl_path), args.tol)
            issues += p

        if issues:
            bad += len(issues)
            print(f"[NG] P{pidx:02d}  {len(issues)} 处问题")
            for i in issues[:8]:
                print(f"      - {i}")
        else:
            extra = f"，最大时间偏差 {worst:.0f}s" if worst is not None else ""
            print(f"[OK] P{pidx:02d}{extra}")

    if bad:
        sys.stderr.write(f"\n共 {bad} 处问题。\n")
        return 3
    print(f"\n全部 {len(cards)} 张卡片通过校验。")
    return 0

# ---------------------------------------------------------------- outline

def cmd_outline(args):
    vid = args.video_id
    kbdir = os.path.join(args.kb, args.collection)
    require(os.path.isfile(args.outline), f"大纲文件不存在：{args.outline}")
    cards = _iter_card_files(kbdir, vid)
    require(bool(cards), f"{kbdir} 下没有 card-{vid}-pNN.md（先 finalize）")

    outline = open(args.outline, encoding="utf-8").read()
    filled = 0

    for pidx, path in cards:
        text = open(path, encoding="utf-8").read()
        _, body = split_frontmatter(text)
        m = re.search(r"^##\s*核心要点\s*$(.*?)(?=^##\s|\Z)", body, re.M | re.S)
        if not m:
            sys.stderr.write(f"WARN: p{pidx:02d} 没有「## 核心要点」段，跳过\n")
            continue
        bullets = [ln.rstrip() for ln in m.group(1).splitlines()
                   if ln.strip().startswith("- ")]
        if not bullets:
            continue

        block = [f"- 笔记区（已填充，详见 [card-{vid}-p{pidx:02d}.md](kb/"
                 f"{args.collection}/card-{vid}-p{pidx:02d}.md)）"]
        block += ["  " + b for b in bullets]

        # 定位大纲里 `## P<n> ·` 段
        head = re.compile(rf"^##\s*P{pidx}\s*·.*$", re.M)
        mh = head.search(outline)
        if not mh:
            sys.stderr.write(f"WARN: 大纲里找不到「## P{pidx} ·」小节，跳过\n")
            continue
        nxt = re.search(r"^##\s", outline[mh.end():], re.M)
        seg_end = mh.end() + (nxt.start() if nxt else len(outline))
        segment = outline[mh.start():seg_end]

        # 用「- 笔记区 …」到下一个空行/分隔线/下一个 h2 之间的整块替换
        repl = re.compile(r"^- 笔记区.*?(?=(?:\n\s*\n|\n---|\n##\s)|\Z)",
                          re.M | re.S)
        if not repl.search(segment):
            sys.stderr.write(f"WARN: P{pidx} 小节里没有「- 笔记区」占位，跳过\n")
            continue
        new_seg = repl.sub("\n".join(block), segment, count=1)
        outline = outline[:mh.start()] + new_seg + outline[seg_end:]
        filled += 1
        print(f"[outline] P{pidx}: 灌入 {len(bullets)} 条要点")

    if args.dry_run:
        print("\n--- 预览（--dry-run，未写盘）---")
        print(outline)
        return 0

    with open(args.outline, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(outline)
    print(f"[outline] 已更新 {filled} 个小节 -> {args.outline}")
    return 0 if filled else 3

# ---------------------------------------------------------------- CLI

def main(argv=None):
    # Windows 控制台默认 GBK，中文/符号混排会崩；统一切到 UTF-8 并容错
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(
        prog="vk_pipeline", description="视频 → 知识卡 可复用流水线",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法示例：")[-1],
    )
    ap.add_argument("--workdir", default="runs", help="中间产物根目录（默认 runs）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    # fetch
    f = sub.add_parser("fetch", help="抓字幕（需要 B 站登录 cookie）")
    f.add_argument("--url", required=True)
    f.add_argument("--video-id")
    f.add_argument("--cookies", help="Netscape 格式 cookie 文件（等同账号密码，用完即删）")
    f.add_argument("--sub-langs", default="ai-zh,zh-Hans,zh-CN")
    f.add_argument("--lang", default="zh-CN")
    f.add_argument("--uploader", default="")
    f.add_argument("--published-at", default="unknown")
    f.add_argument("--ytdlp")
    f.set_defaults(func=cmd_fetch)

    # build
    b = sub.add_parser("build", help="SRT→jsonl→清洗→切块→素材包")
    b.add_argument("--video-id", required=True)
    b.add_argument("--url", default="", help="meta.json 缺失时用于识别平台")
    b.add_argument("--durations", help="meta.json 缺失时用逗号分隔的各 P 时长（秒）")
    b.add_argument("--cleaner")
    b.add_argument("--python", default=sys.executable)
    b.set_defaults(func=cmd_build)

    # finalize
    fin = sub.add_parser("finalize", help="校验+注入 frontmatter+落盘+索引")
    fin.add_argument("--video-id", required=True)
    fin.add_argument("--cards-dir", required=True, help="卡片正文目录（card-<vid>-pNN.md）")
    fin.add_argument("--kb", default="kb")
    fin.add_argument("--collection", default="bilibili")
    fin.add_argument("--tags", default="", help="逗号分隔")
    fin.add_argument("--lang", default="zh-CN")
    fin.add_argument("--storage-mode", default="refined")
    fin.add_argument("--retain-raw", action="store_true")
    fin.add_argument("--tol", type=float, default=5.0, help="时间戳容差秒（默认 5）")
    fin.add_argument("--strict", action="store_true", help="有校验问题即返回 3")
    fin.add_argument("--url", default="")
    fin.add_argument("--durations")
    fin.set_defaults(func=cmd_finalize)

    # check
    c = sub.add_parser("check", help="校验已落盘卡片")
    c.add_argument("--video-id", required=True)
    c.add_argument("--kb", default="kb")
    c.add_argument("--collection", default="bilibili")
    c.add_argument("--tol", type=float, default=5.0)
    c.set_defaults(func=cmd_check)

    # outline
    o = sub.add_parser("outline", help="把卡片要点灌进大纲")
    o.add_argument("--video-id", required=True)
    o.add_argument("--outline", required=True)
    o.add_argument("--kb", default="kb")
    o.add_argument("--collection", default="bilibili")
    o.add_argument("--dry-run", action="store_true")
    o.set_defaults(func=cmd_outline)

    # all
    a = sub.add_parser("all", help="fetch + build 一条命令")
    a.add_argument("--url", required=True)
    a.add_argument("--video-id")
    a.add_argument("--cookies")
    a.add_argument("--sub-langs", default="ai-zh,zh-Hans,zh-CN")
    a.add_argument("--lang", default="zh-CN")
    a.add_argument("--uploader", default="")
    a.add_argument("--published-at", default="unknown")
    a.add_argument("--ytdlp")
    a.add_argument("--cleaner")
    a.add_argument("--python", default=sys.executable)
    a.set_defaults(func=None)  # 见下

    args = ap.parse_args(argv)

    if args.cmd == "all":
        rc = cmd_fetch(args)
        if rc != 0:
            return rc
        args.video_id = args.video_id or (detect_video_id(args.url)[0])
        args.durations = None
        args.url = args.url
        return cmd_build(args)

    if args.cmd == "build":
        args.video_id = args.video_id
    os.makedirs(args.workdir, exist_ok=True)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
