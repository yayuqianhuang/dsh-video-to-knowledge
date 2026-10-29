#!/usr/bin/env node
/**
 * exec-chain.mjs — 插件内置的 AJTC 链执行器
 *
 * 与 dsh 官方 ajtc 工具的区别：引擎自带的 agentStep 只是「代理检查点」，不会真跑命令；
 * 本执行器把节点上的机读 `exec` 规格真正执行，并把 stdout 的 JSON 写回该节点的 `out`。
 *
 * 占位符（运行时解析，因此插件可跨机器/跨平台分发）：
 *   ${python}      探测到的 Python 解释器
 *   ${pluginRoot}  插件根目录（脚本在这里）
 *   ${workDir}     用户可写工作目录（runs/ 与 kb/ 在这里，绝不写进 node_modules）
 *   ${env.NAME}    环境变量
 *   ${$.a.b}       黑板路径，支持 ...length
 *
 * 用法：
 *   node runner/exec-chain.mjs <chainId> --input in.json --workdir D:/vk [--verbose] [--report]
 *
 * 退出码：0 跑通；1 未跑通；3 --strict 下存在模型步骤；2 参数/环境错误
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const ENGINE_ROOT = process.env.AJTC_ROOT || path.join(PLUGIN_ROOT, 'engine');

const { Kernel } = require(path.join(ENGINE_ROOT, 'src', 'engine', 'kernel.js'));
const { Tracer } = require(path.join(ENGINE_ROOT, 'src', 'engine', 'tracer.js'));
const { Registry } = require(path.join(ENGINE_ROOT, 'src', 'registry.js'));
const { MockAdapter } = require(path.join(ENGINE_ROOT, 'src', 'adapters', 'mock.js'));
const { builtins } = require(path.join(ENGINE_ROOT, 'src', 'engine', 'functions.js'));

/* ------------------------------------------------------------------ 参数 */
const argv = process.argv.slice(2);
const opt = { chain: 'gen.video-to-knowledge', input: null, workdir: null, verbose: false, report: false, strict: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--input') opt.input = argv[++i];
  else if (a === '--workdir') opt.workdir = argv[++i];
  else if (a === '--verbose' || a === '-v') opt.verbose = true;
  else if (a === '--report') opt.report = true;
  else if (a === '--strict') opt.strict = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node runner/exec-chain.mjs <chainId> --input in.json --workdir D:/vk [--verbose] [--report] [--strict]');
    process.exit(0);
  } else if (a.startsWith('--')) { console.error(`未知参数: ${a}`); process.exit(2); }
  else opt.chain = a;
}

/* ------------------------------------------------------------------ Python 探测 */
function exeOf(cmd, prefixArgs = []) {
  try {
    const r = spawnSync(cmd, [...prefixArgs, '-c', 'import sys;sys.stdout.write(sys.executable)'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const out = (r.stdout || '').trim();
    if (r.status === 0 && out) return out;
  } catch { /* ignore */ }
  return null;
}

function detectPython() {
  const explicit = process.env.VK_PYTHON;
  if (explicit && fs.existsSync(explicit)) return explicit;
  // Windows 优先用 py 启动器挑 3.x，避免落到老的 python.exe
  if (process.platform === 'win32') {
    const viaPy = exeOf('py', ['-3']);
    if (viaPy && fs.existsSync(viaPy)) return viaPy;
  }
  for (const c of ['python3', 'python']) {
    const e = exeOf(c);
    if (e && fs.existsSync(e)) return e;
  }
  if (process.platform === 'win32') {
    for (const p of [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
    ]) {
      if (p && fs.existsSync(p)) return p;
    }
  }
  return null;
}

const PYTHON = detectPython();
const WORKDIR = path.resolve(opt.workdir || process.env.VK_WORKDIR || path.join(PLUGIN_ROOT, '.runtime', 'work'));
fs.mkdirSync(WORKDIR, { recursive: true });

if (!PYTHON) {
  console.error('ERROR: 未找到 Python。请安装 Python 3.10+，或设置环境变量 VK_PYTHON 指向解释器。');
  process.exit(2);
}

/* ------------------------------------------------------------------ 载入链 */
const reg = new Registry(path.join(ENGINE_ROOT, 'chains')).load();
const chain = reg.get(opt.chain);
if (!chain) { console.error(`找不到链: ${opt.chain}`); process.exit(2); }
const loadChain = reg.loader();

/* ------------------------------------------------------------------ 变量替换 */
function resolveFrom(bb, expr) {
  const t = String(expr).trim();
  if (t === 'python') return PYTHON;
  if (t === 'pluginRoot') return PLUGIN_ROOT;
  if (t === 'workDir') return WORKDIR;
  if (t.startsWith('env.')) return process.env[t.slice(4)] || '';

  let p = t;
  let wantLen = false;
  if (p.endsWith('.length')) { wantLen = true; p = p.slice(0, -7); }
  let v;
  if (bb && typeof bb.get === 'function') v = bb.get(p);
  if (wantLen) return Array.isArray(v) ? v.length : (v == null ? 0 : 1);
  return v;
}

function subst(s, bb) {
  return String(s).replace(/\$\{([^}]+)\}/g, (_, e) => {
    const v = resolveFrom(bb, e);
    return v === undefined || v === null ? '' : String(v);
  });
}

/* ------------------------------------------------------------------ 真执行 agentStep */
const stat = { exec: 0, manual: 0, failed: 0, nodes: [] };

function execSpecOf(node) {
  if (!node) return null;
  return node.exec || (node.in && node.in.exec) || null;
}

function realAgentStep(args, ctx) {
  const node = ctx && ctx.node;
  const spec = execSpecOf(node);
  const nodeId = (node && node.id) || 'agentStep';

  if (!spec) {
    stat.manual++;
    stat.nodes.push({ id: nodeId, mode: 'manual' });
    if (opt.verbose) console.error(`  [skip] ${nodeId}（模型步骤，产物须由外部提供）`);
    return builtins.agentStep(args, ctx);
  }

  const bb = ctx.bb;
  const runner = subst(spec.runner, bb);
  const script = spec.script ? subst(spec.script, bb) : null;
  const cargs = (spec.args || []).map((a) => subst(a, bb));
  const cwd = spec.cwd ? subst(spec.cwd, bb) : WORKDIR;
  const env = { ...process.env };
  for (const [k, v] of Object.entries(spec.env || {})) env[k] = subst(v, bb);

  const full = script ? [script, ...cargs] : cargs;
  if (opt.verbose) console.error(`  [run ] ${nodeId}: ${runner} ${full.join(' ')}  (cwd=${cwd})`);

  const r = spawnSync(runner, full, { cwd, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  stat.exec++;

  if (r.error) {
    stat.failed++;
    throw new Error(`node ${nodeId} 无法启动: ${r.error.message}`);
  }
  if (r.status !== 0) {
    stat.failed++;
    stat.nodes.push({ id: nodeId, mode: 'fail' });
    const tail = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-6).join('\n');
    if (tail) console.error(`  [fail] ${nodeId} exit=${r.status}\n${tail}`);
    throw new Error(`node ${nodeId} exec 失败 (exit ${r.status})`);
  }

  const out = (r.stdout || '').trim();
  let data = null;
  if (out) {
    try { data = JSON.parse(out); }
    catch { throw new Error(`node ${nodeId} 的 stdout 不是合法 JSON`); }
  }
  stat.nodes.push({ id: nodeId, mode: 'exec', ok: data && data.ok });
  if (opt.verbose) console.error(`  [done] ${nodeId}`);
  return { data, signals: [] };
}

/* ------------------------------------------------------------------ 跑 */
if (!opt.input || !fs.existsSync(opt.input)) {
  console.error('ERROR: 缺少 --input <json 文件>');
  process.exit(2);
}
const input = JSON.parse(fs.readFileSync(opt.input, 'utf8'));

if (opt.verbose) {
  console.error(`\n▸ ${chain.id}  节点 ${chain.nodes.length} 个  workDir=${WORKDIR}  python=${PYTHON}`);
}

const tracer = new Tracer({ level: 'error', silent: true });
const kernel = new Kernel({
  chain,
  adapter: new MockAdapter(),
  tracer,
  loadChain,
  fns: { ...builtins, agentStep: realAgentStep },
  preChain: false,
});

const res = await kernel.run(input);
const bb = kernel.bb;

const skippedIds = [...new Set(stat.nodes.filter((n) => n.mode === 'manual').map((n) => n.id))];
const failedIds = [...new Set(stat.nodes.filter((n) => n.mode === 'fail').map((n) => n.id))];
const pick = (p) => bb.get(p);

const report = {
  ok: false,
  chain: chain.id,
  workDir: WORKDIR,
  python: PYTHON,
  haltReason: res.haltReason || null,
  execStat: { exec: stat.exec, manual: stat.manual, failed: stat.failed },
  skippedNodes: skippedIds,
  failedNodes: failedIds,
  signals: {
    env: pick('$.env'),
    quality: pick('$.quality'),
    dedupe: pick('$.dedupe') && {
      hit: pick('$.dedupe.hit'),
      queueCount: pick('$.dedupe.queueCount'),
      skipped: (pick('$.dedupe.skipped') || []).length,
    },
    verify: pick('$.verify'),
    outline: pick('$.outline'),
  },
};

const aborted = /bail/i.test(String(report.haltReason || '')) ||
  (pick('$.output') && pick('$.output.quality') && pick('$.output.quality.aborted') === true);

report.ok = !stat.failed && !aborted &&
  (!report.signals.verify || report.signals.verify.ok === true) &&
  (!report.signals.quality || report.signals.quality.ok === true);

if (report.ok && opt.strict && stat.manual > 0) {
  report.ok = false;
  report.reason = `--strict：仍有 ${stat.manual} 个模型步骤被跳过（${skippedIds.join(', ')}）`;
}

if (opt.report) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const s = report.signals;
  console.log(`终止原因 ${report.haltReason || '事件队列耗尽'}`);
  console.log(`exec ${report.execStat.exec} 次 · 跳过 ${report.execStat.manual} 个 · 失败 ${report.execStat.failed}`);
  if (skippedIds.length) console.log(`模型步骤 ${skippedIds.join(', ')}`);
  if (s.env) console.log(`env     biliLogin=${s.env.biliLogin} missing=[${(s.env.missing || []).join(',')}]`);
  if (s.quality) console.log(`quality ok=${s.quality.ok} issues=${(s.quality.issues || []).length}`);
  if (s.dedupe) console.log(`dedupe  hit=${s.dedupe.hit} queue=${s.dedupe.queueCount}`);
  if (s.verify) console.log(`verify  expected=${s.verify.expected} actual=${s.verify.actual} ok=${s.verify.ok}`);
  if (s.outline) console.log(`outline updated=${s.outline.updated}`);
  console.log(report.ok ? '✔ 链跑通' : '✘ 链未跑通');
}

process.exit(report.ok ? 0 : 1);
