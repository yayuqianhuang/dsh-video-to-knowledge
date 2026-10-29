/**
 * dsh-video-to-knowledge — DeepSeek Harness (dsh) 插件
 *
 * 把「视频链接 → 带时间戳的 Markdown 知识卡 → 落盘 kb/」这条 AJTC 触发链封装成开箱可用的工具。
 *
 * 与 ajtc-chain-engine 的区别：
 *   · 该链的 agentStep 节点带机读 `exec` 规格，本插件内置 runner/exec-chain.mjs **真执行**它们；
 *   · 原先的 ajtc_run_chain 只能 `--mock`（引擎自带的 agentStep 只记录不执行），跑不出真卡片。
 *
 * 工具：
 *   vk_doctor   环境自检（Python / yt-dlp / ffmpeg / whisper / B 站登录态）
 *   vk_prepare  抓元数据 + 抓字幕 + 清洗切块 → 产出 by_p 素材包（供模型写卡片正文）
 *   vk_run      跑完整触发链（校验 → 查重 → 落盘 → 核验 → 可选回写大纲）
 *   ajtc_list_chains / ajtc_run_chain / ajtc_recall_memory  保留原 AJTC 能力
 *
 * 依赖（插件无法自带，需用户安装）：Python 3.10+、yt-dlp；走本地 ASR 还需 ffmpeg + faster-whisper。
 * B 站字幕需要用户自己的登录 cookie（本插件只接受路径，绝不读取/记录内容）。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-video-to-knowledge'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = join(HERE, 'engine')
const CLI = join(ENGINE_DIR, 'src', 'cli.js')
const PIPELINE_DIR = join(HERE, 'pipeline')
const RUNNER = join(HERE, 'runner', 'exec-chain.mjs')
const MEMORY_DIR = join(HERE, 'memory')
const SHADOW_DIR = join(HERE, '.runtime', 'shadow')

try { mkdirSync(SHADOW_DIR, { recursive: true }) } catch { /* 只读安装时忽略 */ }

/* ------------------------------------------------------------------ 配置层
 * dsh 的「设置页」需要插件自带客户端 bundle（宿主不会从 Schema 生成），本插件不发布客户端。
 * 因此配置只有两个真正需要用户关心的项：
 *   ① outputDir   输出根目录 —— 默认 = 当前 DSH 工作区（可精确探测，见 workspaceInfo）
 *   ② cookiesPath B 站 cookie 文件（可选，只有 need_login_subtitle 的视频才需要）
 * 另有 pythonPath 作为高级项（一般留空自动探测）。
 */
const CONFIG_DIR = process.env.VK_CONFIG_DIR || join(homedir(), '.dsh-video-to-knowledge')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

/** 默认输出子目录：产物落到 <工作区>/videoToKnowledge/，避免与工作区已有的 kb/、runs/ 混杂。
 *  注意：显式指定 outputDir 时**不再**套这层，用户给什么就是什么。 */
const DEFAULT_SUBDIR = 'videoToKnowledge'

/** dsh 把工作区路径编码成 ~/.dsh/sessions/--<encoded>-- 目录名 */
function encodeWorkspace(p) {
  return String(p)
    .replace(/:/g, '')
    .replace(/[\\/]/g, '-')
    .replace(/ /g, '~0020')
    .replace(/\(/g, '~0028')
    .replace(/\)/g, '~0029')
}

/** 判断一个目录是不是 dsh 工作区、是否属于当前会话 */
function workspaceInfo(dir) {
  const out = { path: dir, encoded: null, isWorkspace: false, isCurrentSession: false }
  try {
    const enc = `--${encodeWorkspace(dir)}--`
    out.encoded = enc
    const base = join(homedir(), '.dsh', 'sessions', enc)
    out.isWorkspace = existsSync(base)
    const sid = process.env.DSH_SESSION_ID
    if (out.isWorkspace && sid) out.isCurrentSession = existsSync(join(base, sid))
  } catch { /* 忽略 */ }
  return out
}

/**
 * 从编码目录名还原真实路径。
 * 编码把 '\' 换成 '-'，而路径本身也可能含 '-'（如 dsh-plugins），单靠字符串无法还原；
 * 因此对每个 '-' 回溯两种可能（分隔符 or 字面字符），用文件系统存在性剪枝。
 */
function decodeWorkspaceName(name) {
  const enc = String(name).replace(/^--/, '').replace(/--$/, '')
  const unesc = (s) => s
    .replace(/~0020/g, ' ')
    .replace(/~0028/g, '(')
    .replace(/~0029/g, ')')

  // POSIX 绝对路径：编码后以 '-' 开头
  const isPosix = enc.startsWith('-')
  const parts = (isPosix ? enc.slice(1) : enc).split('-').map(unesc)
  if (parts.length === 0) return null

  let start
  let rest
  if (isPosix) { start = '/'; rest = parts }
  else if (/^[A-Za-z]$/.test(parts[0])) { start = `${parts[0]}:`; rest = parts.slice(1) }
  else { start = parts[0]; rest = parts.slice(1) }

  const walk = (i, acc) => {
    if (i >= rest.length) return existsSync(acc) ? acc : null
    for (const sep of ['\\', '-', '/']) {
      const cand = acc + sep + rest[i]
      let parentOk = false
      try { parentOk = existsSync(dirname(cand)) } catch { parentOk = false }
      if (!parentOk) continue
      const r = walk(i + 1, cand)
      if (r) return r
    }
    return null
  }
  try { return walk(0, start) } catch { return null }
}

/** 由当前会话反查工作区真实路径（不依赖进程 cwd） */
function discoverWorkspaceFromSession() {
  const sid = process.env.DSH_SESSION_ID
  if (!sid) return null
  const base = join(homedir(), '.dsh', 'sessions')
  let names = []
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch { return null }
  for (const n of names) {
    if (existsSync(join(base, n, sid))) {
      const real = decodeWorkspaceName(n)
      if (real) return real
    }
  }
  return null
}

const CONFIG_KEYS = {
  outputDir: {
    env: 'VK_OUTPUT_DIR',
    desc: '输出根目录。默认 = <工作区>/videoToKnowledge/（工作区本身叫这个名字时不再套一层）；卡片落 <它>/kb/<collection>/，中间产物落 <它>/runs/',
  },
  cookiesPath: {
    env: 'BILI_COOKIES',
    desc: 'B 站 cookie 文件路径（Netscape 格式，可选）。不填则只能处理无需登录的视频',
  },
  pythonPath: {
    env: 'VK_PYTHON',
    desc: '高级：Python 解释器绝对路径；留空自动探测（py -3 / python3 / python）',
  },
}

function readConfigFile() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

function writeConfigFile(obj) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8')
}

/** 取值优先级：显式入参 > 环境变量 > 配置文件 > 默认值 */
function cfg(key, explicit, fallback = '') {
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit
  const envName = CONFIG_KEYS[key] && CONFIG_KEYS[key].env
  if (envName && process.env[envName]) return process.env[envName]
  const f = readConfigFile()
  if (f[key] !== undefined && f[key] !== null && f[key] !== '') return f[key]
  return fallback
}

/**
 * 解析输出根目录。优先级：入参 > env > 配置文件 > 会话工作区 > cwd。
 * 未显式指定时，产物落到 <工作区>/videoToKnowledge/（见 DEFAULT_SUBDIR）。
 * 「会话工作区」不依赖进程 cwd：用 DSH_SESSION_ID 在 ~/.dsh/sessions 下反查并还原真实路径。
 */
function resolveOutputDir(explicit) {
  const picked = cfg('outputDir', explicit)
  if (picked) {
    const abs = resolve(picked)
    mkdirSync(abs, { recursive: true })
    const source = (explicit !== undefined && explicit !== null && explicit !== '')
      ? 'arg' : (process.env.VK_OUTPUT_DIR ? 'env' : 'file')
    return { dir: abs, base: abs, subdir: false, reason: 'explicit', source, ws: workspaceInfo(abs) }
  }

  const discovered = discoverWorkspaceFromSession()
  const base = discovered || process.cwd()
  // 守卫：工作区本身就叫 videoToKnowledge 时不再套一层，避免 xxx/videoToKnowledge/videoToKnowledge
  const already = basename(base).toLowerCase() === DEFAULT_SUBDIR.toLowerCase()
  const dir = already ? base : join(base, DEFAULT_SUBDIR)
  try { mkdirSync(dir, { recursive: true }) } catch { /* 只读则忽略 */ }
  const ws = workspaceInfo(base)
  const source = discovered
    ? 'workspace(session)'
    : (ws.isCurrentSession ? 'workspace(current)' : (ws.isWorkspace ? 'workspace' : 'cwd'))
  return { dir, base, subdir: !already, reason: already ? 'already-named' : 'appended', source, ws }
}

/* ------------------------------------------------------------------ 通用进程封装 */

function spawnCap(cmd, args, { cwd, env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolveP) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true })
    } catch (e) {
      return resolveP({ code: -1, stdout: '', stderr: String(e && e.message) })
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => { clearTimeout(timer); resolveP({ code: -1, stdout, stderr: String(e && e.message) }) })
    child.on('close', (code) => { clearTimeout(timer); resolveP({ code: code ?? 0, stdout, stderr }) })
  })
}

/** 子进程跑 ajtc CLI（保留原能力，用于 mock 演示 / 列链） */
function runCli(args, extraEnv = {}, timeoutMs = 180_000) {
  return spawnCap(process.execPath, [CLI, ...args], {
    cwd: ENGINE_DIR,
    env: { ...process.env, AJTC_SHADOW_DIR: SHADOW_DIR, ...extraEnv },
    timeoutMs,
  })
}

/* ------------------------------------------------------------------ Python 探测 */

function exeOf(cmd, prefixArgs = []) {
  return new Promise(async (resolveP) => {
    const r = await spawnCap(cmd, [...prefixArgs, '-c', 'import sys;sys.stdout.write(sys.executable)'],
      { timeoutMs: 8000 })
    const out = (r.stdout || '').trim()
    resolveP(r.code === 0 && out ? out : null)
  })
}

let _python
async function detectPython() {
  if (_python !== undefined) return _python
  const explicit = cfg('pythonPath')
  if (explicit && existsSync(explicit)) return (_python = explicit)
  if (process.platform === 'win32') {
    const viaPy = await exeOf('py', ['-3'])
    if (viaPy && existsSync(viaPy)) return (_python = viaPy)
  }
  for (const c of ['python3', 'python']) {
    const e = await exeOf(c)
    if (e && existsSync(e)) return (_python = e)
  }
  _python = null
  return null
}

/* ------------------------------------------------------------------ 工作目录 */

function resolveWorkDir(input) {
  return resolveOutputDir(input).dir
}

/** 跑 pipeline 下的 Python 脚本；stdout 约定为单个 JSON */
async function runPy(scriptName, args, { workDir, cookiesPath, timeoutMs } = {}) {
  const py = await detectPython()
  if (!py) {
    return { ok: false, error: '未找到 Python。请安装 Python 3.10+，或设置环境变量 VK_PYTHON 指向解释器。' }
  }
  const env = { ...process.env }
  if (cookiesPath) env.BILI_COOKIES = cookiesPath
  const r = await spawnCap(py, [join(PIPELINE_DIR, scriptName), ...args], {
    cwd: workDir, env, timeoutMs: timeoutMs || 900_000,
  })
  if (r.code !== 0) {
    return {
      ok: false,
      exitCode: r.code,
      error: (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-12).join('\n') || '(无输出)',
    }
  }
  try {
    return { ok: true, data: JSON.parse(r.stdout) }
  } catch {
    return { ok: false, error: `脚本 ${scriptName} 的 stdout 不是合法 JSON`, raw: r.stdout.slice(-500) }
  }
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] }
}

const j = (o) => JSON.stringify(o, null, 2)

/* ------------------------------------------------------------------ 原有：链枚举 / 记忆召回 */

function listChains() {
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) walk(p)
      else if (e.endsWith('.json')) {
        try {
          const o = JSON.parse(readFileSync(p, 'utf8'))
          if (o && typeof o.id === 'string' && o.title) {
            out.push({ id: o.id, title: o.title, nodes: Array.isArray(o.nodes) ? o.nodes.length : 0 })
          }
        } catch { /* 非链 JSON */ }
      }
    }
  }
  walk(join(ENGINE_DIR, 'chains'))
  return out
}

function recallMemory(query, max = 6) {
  const terms = String(query || '').toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean)
  if (terms.length === 0) return '(空查询)'
  const hits = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) walk(p)
      else if (/\.(md|json)$/.test(e)) {
        let text = ''
        try { text = readFileSync(p, 'utf8') } catch { continue }
        const low = text.toLowerCase()
        const score = terms.reduce((a, t) => a + (low.includes(t) ? 1 : 0), 0)
        if (score > 0) {
          const ctx = text.split('\n').filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 3).join('\n')
          hits.push({ rel: p.replace(HERE, '.'), score, ctx })
        }
      }
    }
  }
  walk(MEMORY_DIR)
  const ironLaws = join(ENGINE_DIR, 'chains', 'governance', 'iron-laws.json')
  try {
    const text = readFileSync(ironLaws, 'utf8')
    const low = text.toLowerCase()
    const score = terms.reduce((a, t) => a + (low.includes(t) ? 1 : 0), 0)
    if (score > 0) {
      hits.push({
        rel: ironLaws.replace(HERE, '.'), score,
        ctx: text.split('\n').filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 3).join('\n'),
      })
    }
  } catch { /* 无铁律文件 */ }
  hits.sort((a, b) => b.score - a.score)
  if (hits.length === 0) return '(记忆层未匹配到相关条目)'
  return hits.slice(0, max).map((h) => `[${h.rel}]\n${h.ctx}`).join('\n\n')
}

/* ------------------------------------------------------------------ 插件入口 */

export function apply(ctx) {
  /* ---------- 1) 环境自检 ---------- */
  ctx.tools.register({
    name: 'vk_doctor',
    description:
      '视频转知识链的环境自检：检查 Python / yt-dlp / ffmpeg / faster-whisper 是否可用，以及 B 站登录态。' +
      '不会联网抓取内容；B 站登录态只判断 cookie 文件是否存在且含 SESSDATA，不打印任何凭据内容。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '可选：要处理的视频链接，用于判断平台' },
        outputDir: { type: 'string', description: '可选：输出根目录，默认 = 当前 DSH 工作区' },
        workDir: { type: 'string', description: '（兼容别名）等同 outputDir' },
        cookiesPath: { type: 'string', description: '可选：B 站 cookie 文件（Netscape 格式）路径，仅传给子进程' },
      },
      required: [],
    },
    async execute({ url = '', workDir, cookiesPath } = {}) {
      const wd = resolveWorkDir(workDir)
      const ck = cfg('cookiesPath', cookiesPath)
      const py = await detectPython()
      const args = ['doctor']
      if (url) args.push('--url', url)
      const r = await runPy('vk_chain.py', args, { workDir: wd, cookiesPath: ck })
      if (!r.ok) {
        return textResult(
          `环境自检失败：${r.error}\n\n` +
          `· Python 探测结果：${py || '(未找到)'}\n` +
          `· 提示：设置环境变量 VK_PYTHON 可指定解释器`,
        )
      }
      const d = r.data
      const lines = [
        `Python      ${py}`,
        `yt-dlp      ${d.ytdlp ? d.ytdlpPath : '缺失'}`,
        `ffmpeg      ${d.ffmpeg ? d.ffmpegPath : '缺失（仅本地 ASR 需要）'}`,
        `whisper     ${d.whisper ? '可用' : '不可用（仅本地 ASR 需要）'}`,
        `B站登录态   ${d.biliLogin}（模式 ${d.credMode}）`,
        `缺失项      ${d.missing.length ? d.missing.join(', ') : '无'}`,
        `工作目录    ${wd}`,
        `配置文件    ${CONFIG_FILE}${existsSync(CONFIG_FILE) ? '' : '（尚未创建，可用 vk_config 写）'}`,
      ]
      if (d.missing.length) {
        lines.push('', '修复建议：')
        if (d.missing.includes('yt-dlp')) lines.push('· 安装 yt-dlp：pip install -U yt-dlp')
        if (d.missing.includes('biliLogin')) lines.push('· 提供 B 站 cookie：用浏览器扩展导出 Netscape 格式，保存为文件后通过 cookiesPath 传入')
      }
      return textResult(lines.join('\n') + '\n\n' + j(d))
    },
  })

  /* ---------- 2) 素材准备 ---------- */
  ctx.tools.register({
    name: 'vk_prepare',
    description:
      '准备知识卡素材：抓视频元数据 → 抓字幕（B 站需登录 cookie）→ 清洗切块 → 产出按分 P 的素材包。' +
      '返回每个分 P 的素材文件路径与顺序时间轴，供你（模型）撰写卡片正文。' +
      '完成后调用 vk_run 组装、校验并落盘。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '视频链接（bilibili / youtube）' },
        outputDir: { type: 'string', description: '输出根目录，默认 = 当前 DSH 工作区' },
        workDir: { type: 'string', description: '（兼容别名）等同 outputDir' },
        cookiesPath: { type: 'string', description: 'B 站 cookie 文件（Netscape 格式）。仅注入子进程，不落盘不打印' },
        lang: { type: 'string', default: 'zh-CN' },
        refresh: { type: 'boolean', default: false, description: 'true=忽略缓存重新抓取' },
      },
      required: ['url'],
    },
    async execute({ url, workDir, cookiesPath, lang = 'zh-CN', refresh = false } = {}) {
      const wd = resolveWorkDir(workDir)
      const ck = cfg('cookiesPath', cookiesPath)

      const meta = await runPy('vk_chain.py', ['meta', '--url', url, ...(refresh ? ['--refresh'] : [])],
        { workDir: wd, cookiesPath: ck })
      if (!meta.ok) return textResult(`抓元数据失败：${meta.error}`)
      const videoId = meta.data.videoId

      const tr = await runPy('vk_chain.py',
        ['transcript', '--url', url, '--video-id', videoId, '--lang', lang, ...(refresh ? ['--refresh'] : [])],
        { workDir: wd, cookiesPath: ck })
      if (!tr.ok) {
        return textResult(
          `抓字幕失败：${tr.error}\n\n` +
          `常见原因：\n` +
          `· 该视频 need_login_subtitle=true，必须提供 cookiesPath（B 站登录 cookie）\n` +
          `· cookie 已过期 → 重新导出\n` +
          `· 该视频确实没有 AI/官方字幕\n` +
          `· 语言代码不对（B 站 AI 字幕通常是 ai-zh）`,
        )
      }

      // meta.json 已由上一步写好，build 会直接读它，不需要再传 --durations
      const built = await runPy('vk_pipeline.py', ['build', '--video-id', videoId, '--url', url], { workDir: wd })
      if (!built.ok) return textResult(`清洗/切块失败：${built.error}`)

      const byp = join(wd, 'runs', videoId, 'by_p')
      let materials = []
      try {
        materials = readdirSync(byp).filter((f) => /^p\d+\.txt$/.test(f)).sort()
          .map((f) => ({ part: Number(f.slice(1, 3)), file: join(byp, f) }))
      } catch { /* 目录可能不存在 */ }

      return textResult(j({
        videoId,
        title: meta.data.title,
        durationSec: tr.data.durationSec,
        segmentCount: tr.data.segmentCount,
        coveredSec: tr.data.coveredSec,
        parts: tr.data.partCount,
        workDir: wd,
        materialDir: byp,
        materials,
        next: [
          `1) 逐个读 materials[].file，按分 P 写卡片正文到 ${join(wd, 'cards')}/card-${videoId}-pNN.md`,
          '2) 正文只要 Markdown（标题/一句话结论/核心要点/章节时间轴/关键概念/可执行清单/存疑），不要写 frontmatter',
          '3) 每个 [mm:ss] 必须来自素材里真实出现过的时间戳',
          `4) 写完调用 vk_run（videoId=${videoId}）完成组装、校验与落盘`,
        ],
      }))
    },
  })

  /* ---------- 3) 跑完整链 ---------- */
  ctx.tools.register({
    name: 'vk_run',
    description:
      '运行完整的 video-to-knowledge 触发链：环境门 → 素材 → 五项质量校验 → 查重 → 落盘 kb/<collection>/ → 计数核验 →（可选）回写大纲。' +
      '需要 cards 目录里已存在卡片正文（先用 vk_prepare 拿素材、由模型写正文）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        videoId: { type: 'string', description: '可选；不给则由 url 解析' },
        kbPath: { type: 'string', description: '知识库根目录（卡片落到 kbPath/<collection>/）' },
        collection: { type: 'string', default: 'bilibili' },
        mode: { type: 'string', enum: ['upload', 'dryRun'], default: 'upload' },
        outlinePath: { type: 'string', description: '可选：把卡片要点回写到这个 Markdown 大纲' },
        cardsDir: { type: 'string', description: '可选：卡片正文目录，默认 <outputDir>/cards' },
        outputDir: { type: 'string', description: '输出根目录，默认 = 当前 DSH 工作区（卡片落 <它>/kb/<collection>/）' },
        workDir: { type: 'string', description: '（兼容别名）等同 outputDir' },
        cookiesPath: { type: 'string', description: 'B 站 cookie 文件路径（需要重新抓字幕时才用到）' },
        strict: { type: 'boolean', default: false, description: 'true=存在模型步骤即判失败（验证是否真无人值守）' },
      },
      required: ['url', 'kbPath'],
    },
    async execute({ url, videoId, kbPath, collection = 'bilibili', mode = 'upload', outlinePath,
      cardsDir, outputDir, workDir, cookiesPath, strict = false } = {}) {
      const od = resolveOutputDir(outputDir || workDir)
      const wd = od.dir
      const cKb = kbPath || join(wd, 'kb')
      const cCookies = cfg('cookiesPath', cookiesPath)
      const inputPath = join(wd, '.vk-input.json')
      writeFileSync(inputPath, j({
        url,
        videoId: videoId || undefined,
        kbPath: cKb,
        collection: collection || 'bilibili',
        lang: 'zh-CN',
        mode: mode || 'upload',
        outlinePath: outlinePath || undefined,
        cardsDir: cardsDir || undefined,
      }), 'utf8')

      const env = { ...process.env }
      if (cCookies) env.BILI_COOKIES = cCookies
      const py = await detectPython()
      if (py) env.VK_PYTHON = py
      const args = [RUNNER, 'gen.video-to-knowledge', '--input', inputPath, '--workdir', wd, '--report']
      if (strict) args.push('--strict')
      const r = await spawnCap(process.execPath, args, { cwd: HERE, env, timeoutMs: 900_000 })

      let report = null
      try { report = JSON.parse(r.stdout) } catch { /* 下方兜底 */ }
      if (!report) {
        return textResult(
          `链执行失败（exit ${r.code}）\n\n` +
          `${(r.stderr || '').trim().split(/\r?\n/).slice(-15).join('\n') || '(无 stderr)'}`,
        )
      }
      if (!report.ok) {
        const bad = report.failedNodes || []
        const hints = []
        if (bad.includes('synthesize')) {
          hints.push(`· synthesize 失败：<outputDir>/cards/ 里缺卡片正文。先 vk_prepare 拿素材，再把正文写到 ${join(wd, 'cards')}/card-<videoId>-pNN.md`)
        }
        if (bad.includes('acquireTranscript')) {
          hints.push('· acquireTranscript 失败：多半是没给 cookiesPath（B 站 need_login_subtitle），或 cookie 已过期')
        }
        if (report.signals?.quality?.ok === false) {
          hints.push('· quality 不过：看 issues —— 常见是 [mm:ss] 超出该分 P 区间、字数 <500、frontmatter 缺字段')
        } else if (bad.includes('qualityCheck')) {
          hints.push('· qualityCheck 失败：通常是上游 synthesize 没产出 card.json —— 先补 cards/')
        }
        if (report.signals?.verify?.ok === false) {
          hints.push(`· verify 不过：计数 ${report.signals.verify.actual}/${report.signals.verify.expected}，failures=${report.signals.verify.failures}`)
        }
        if (bad.length) hints.unshift(`失败节点：${bad.join(', ')}`)
        return textResult(
          `链未跑通\n\n${j(report)}\n\n` + (hints.length ? hints.join('\n') : '· 加 --verbose 重跑可看到各节点的实际命令与报错'),
        )
      }
      const q = report.signals?.quality
      const d = report.signals?.dedupe
      const v = report.signals?.verify
      const o = report.signals?.outline
      return textResult(
        `链跑通 ✔\n` +
        `· 卡片 ${q?.stats?.files ?? '?'} 张，quality ok=${q?.ok}\n` +
        `· 查重 queue=${d?.queueCount ?? '?'}，hit=${d?.hit}\n` +
        (v ? `· 核验 ${v.actual}/${v.expected} ok=${v.ok}\n` : '· 核验 跳过（没有待写入文件）\n') +
        (o ? `· 大纲回写 ${o.updated} 节\n` : '') +
        (report.skippedNodes?.length ? `· 模型步骤跳过：${report.skippedNodes.join(', ')}\n` : '') +
        `\n${j(report)}`,
      )
    },
  })

  /* ---------- 3.5) 配置 ---------- */
  ctx.tools.register({
    name: 'vk_config',
    description:
      '查看 / 修改本插件配置。dsh 的图形设置页需要插件自带客户端 bundle，本插件不发布客户端，' +
      '所以配置走这里（写入用户目录下的 config.json）或环境变量。生效优先级：工具入参 > 环境变量 > 配置文件 > 默认。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'unset'], default: 'get' },
        key: {
          type: 'string',
          description: 'workDir | kbPath | collection | cookiesPath | pythonPath | outlinePath | mode',
        },
        value: { type: 'string' },
      },
      required: [],
    },
    async execute({ action = 'get', key, value } = {}) {
      const file = readConfigFile()

      if (action === 'set') {
        if (!key || !CONFIG_KEYS[key]) {
          return textResult(`未知配置键：${key || '(空)'}\n可用：${Object.keys(CONFIG_KEYS).join(', ')}`)
        }
        if (value === undefined || value === '') return textResult('set 需要非空 value')
        file[key] = String(value)
        writeConfigFile(file)
        return textResult(`已写入 ${key} = ${value}\n配置文件：${CONFIG_FILE}\n\n` +
          '生效优先级：工具入参 > 环境变量 > 配置文件 > 默认')
      }

      if (action === 'unset') {
        if (!key || !CONFIG_KEYS[key]) return textResult(`未知配置键：${key || '(空)'}`)
        delete file[key]
        writeConfigFile(file)
        return textResult(`已移除 ${key}（仅从配置文件删除；若设置了同名环境变量 ${CONFIG_KEYS[key].env}，它仍会生效）`)
      }

      const eff = { outputDir: resolveOutputDir() }
      const ck = cfg('cookiesPath')
      const py = cfg('pythonPath')
      const saved = readConfigFile()
      const srcOf = (k) => (saved[k] ? 'file' : (process.env[CONFIG_KEYS[k].env] ? 'env' : 'default'))
      const rows = [
        `outputDir    ${eff.outputDir.dir.padEnd(46)} [${eff.outputDir.source}]`,
        `cookiesPath  ${(ck || '(未设置，可选)').padEnd(46)} [${ck ? srcOf('cookiesPath') : 'default'}]`,
        `pythonPath   ${(py || '(自动探测)').padEnd(46)} [${py ? srcOf('pythonPath') : 'default'}]`,
      ]
      const ws = eff.outputDir.ws
      const od = eff.outputDir
      return textResult(
        `当前生效配置（优先级：入参 > env > 文件 > 默认）\n\n${rows.join('\n')}\n\n` +
        '输出根目录是怎么定的：\n' +
        `· 当前进程 cwd        ${process.cwd()}\n` +
        `· 工作区              ${od.base}\n` +
        `· 子目录规则          ${od.reason === 'explicit' ? '按你指定的路径，不追加子目录'
          : od.reason === 'already-named' ? `工作区本身就叫 ${DEFAULT_SUBDIR}，不再套一层`
            : `默认追加 ${DEFAULT_SUBDIR}/`}\n` +
        `· 是否 DSH 工作区      ${ws.isWorkspace ? '是' : '否'}${ws.isCurrentSession ? '（且属于当前会话）' : ''}\n` +
        (ws.encoded ? `· sessions 目录名     ${ws.encoded}\n` : '') +
        `· 卡片落盘位置        ${join(od.dir, 'kb', '<collection>')}\n` +
        `· 中间产物位置        ${join(od.dir, 'runs')}\n\n` +
        `配置文件：${CONFIG_FILE}${existsSync(CONFIG_FILE) ? '' : '（尚未创建）'}\n\n` +
        `键说明：\n${Object.entries(CONFIG_KEYS).map(([k, v]) => `· ${k}（env ${v.env}）：${v.desc}`).join('\n')}`,
      )
    },
  })

  /* ---------- 4) 原有 AJTC 能力 ---------- */
  ctx.tools.register({
    name: 'ajtc_run_chain',
    description:
      '运行 AJTC 引擎中的任意一条链（**只有 mock 适配器，agentStep 不会真执行**）。' +
      '适合验证链结构与信号接线；需要真跑的请用 vk_run。',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'string' },
        goal: { type: 'string' },
        json: { type: 'boolean', default: true },
      },
      required: ['chainId'],
    },
    async execute({ chainId, goal = '', json = true }) {
      const args = ['run', String(chainId), '--mock', json ? '--json' : '', '--quiet'].filter(Boolean)
      if (goal) args.push('--goal', goal)
      const { code, stdout, stderr } = await runCli(args, {})
      if (code !== 0 && !stdout) return textResult(`链运行失败 (exit ${code}):\n${stderr || '(无 stderr)'}`)
      return textResult(stdout || stderr)
    },
  })

  ctx.tools.register({
    name: 'ajtc_list_chains',
    description: '列出 AJTC 引擎中已注册的全部触发链（id / 标题 / 节点数）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      const chains = listChains()
      if (chains.length === 0) return textResult('(未找到任何链)')
      return textResult(`已注册 ${chains.length} 条触发链：\n` +
        chains.map((c) => `- ${c.id}  ·  ${c.title}  (${c.nodes} 节点)`).join('\n'))
    },
  })

  ctx.tools.register({
    name: 'ajtc_recall_memory',
    description: '在 AJTC 策展记忆层（铁律 / 资产登记模板 / 治理台账模板）中按关键词召回片段。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max: { type: 'number', default: 6 },
      },
      required: ['query'],
    },
    async execute({ query, max = 6 }) {
      return textResult(recallMemory(query, Number(max) || 6))
    },
  })

  /* ---------- system prompt ---------- */
  // systemPrompt 不是 Cordis 可注入服务：直接访问属性会抛，故用 try/catch 兜住
  let sp = null
  try { sp = ctx.systemPrompt } catch { sp = null }
  if (sp && typeof sp.section === 'function') {
    sp.section(() => ({
      role: 'system',
      content:
        '[视频转知识链 · dsh-video-to-knowledge 已挂载]\n' +
        '可以把视频链接编译成带时间戳、可回跳的 Markdown 知识卡并落盘到 kb/。\n' +
        '标准流程：\n' +
        '• vk_doctor  —— 先自检（Python / yt-dlp / B 站登录态）。缺依赖时不要硬跑。\n' +
        '• vk_config  —— 查看/设置 workDir、kbPath、cookiesPath 等（本插件无图形设置页）。\n' +
        '• vk_prepare —— 抓元数据 + 字幕 + 清洗切块，返回按分 P 的素材包。\n' +
        '• （模型自己）读素材，写卡片正文到 <workDir>/cards/card-<videoId>-pNN.md，不要写 frontmatter。\n' +
        '• vk_run     —— 组装 + 五项质量校验 + 查重 + 落盘 + 核验（+ 可选回写大纲）。\n' +
        '硬约束：卡片里的每个 [mm:ss] 必须来自素材中真实出现过的时间戳；不得编造。\n' +
        'B 站部分视频 need_login_subtitle=true，必须由用户提供 cookie 文件路径；绝不读取或记录其内容。\n' +
        '另保留原 AJTC 能力：ajtc_list_chains / ajtc_run_chain（mock）/ ajtc_recall_memory。',
    }))
  }
}
