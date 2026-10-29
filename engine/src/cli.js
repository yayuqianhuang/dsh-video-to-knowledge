#!/usr/bin/env node
'use strict';
/**
 * cli.js —— ajtc 命令行
 *
 *   ajtc init [--force]            初始化元链 sys.genesis（系统自举）
 *   ajtc new "<建链需求>" [选项]     用元链生成一条新链
 *   ajtc lint <链id|文件>           静态检查
 *   ajtc run <链id|文件> [选项]      运行一条链
 *   ajtc list                       列出已注册的链
 *   ajtc viz <链id>                 打印链路图（ASCII）
 *   ajtc roles                      列出可用角色模板
 *   ajtc shadow <链id> --record [--input x.json]           录制回放基线
 *   ajtc shadow <链id> --baseline <rec.json> [--noop f1,f2]  回放比对
 *   ajtc shadow --diff <报告A.json> <报告B.json>                一致性闸门
 *
 * 通用选项：
 *   --mock            强制使用离线 mock 模型（默认即 mock，确定性、零外部依赖）
 *   --input <file>    JSON 输入文件
 *   --goal "<text>"   直接给一句目标
 *   --id <chainId>    指定新链 id
 *   --log <level>     debug|info|warn|error（默认 info）
 *   --json            以 JSON 输出结果
 *   --out <file>      结果写入文件
 */

const fs = require('fs');
const path = require('path');

const { Kernel } = require('./engine/kernel');
const { Tracer } = require('./engine/tracer');
const { Registry } = require('./registry');
const { MockAdapter } = require('./adapters/mock');
const { Blackboard } = require('./engine/blackboard');
const { preludeFns } = require('./engine/prelude-fns');
const { builtins, SIDE_EFFECT_HINTS } = require('./engine/functions');
const { genesisFns } = require('./governance/functions');
const { buildGenesisChain } = require('./governance/bootstrap');
const { lint, formatFindings } = require('./governance/lint');
const { ROLES } = require('./governance/templates');

const ROOT = path.resolve(__dirname, '..');
// [vendored-patch] 允许安装到只读 node_modules 时把 run-shadow 录制重定向到可写目录
const SHADOW_DIR = process.env.AJTC_SHADOW_DIR ? path.resolve(process.env.AJTC_SHADOW_DIR) : path.join(ROOT, 'run-shadow');
const C = { dim: '\x1b[90m', b: '\x1b[1m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m' };

// 纯布尔 flag：绝不消费后续词元（避免 --diff a b 被误当成 --diff=a）
const BOOL_FLAGS = new Set(['diff', 'record', 'mock', 'quiet', 'json', 'force', 'help']);
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nx = argv[i + 1];
      if (nx && !nx.startsWith('--') && !BOOL_FLAGS.has(k)) { out.flags[k] = nx; i++; }
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

// 本插件仅内置离线 mock 适配器（确定性、可复现、零外部依赖）。
// 真实 LLM 不在插件范围内（按用户验收：仅 mock）。记忆后端（TencentDB / 本地）见 memory-fns.js，可经环境变量切换。
function makeAdapter() {
  return new MockAdapter({ latency: 0 });
}

function readInput(flags) {
  if (flags.input) {
    const p = path.isAbsolute(flags.input) ? flags.input : path.resolve(process.cwd(), flags.input);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  if (flags.goal) return { goal: flags.goal };
  return null;
}

/* ------------------------------------------------------------------ */
function cmdInit(args) {
  const reg = new Registry(path.join(ROOT, 'chains')).load();
  const chain = buildGenesisChain();

  const res = lint(chain, {
    knownFns: [...Object.keys(builtins), ...Object.keys(genesisFns({ registry: reg })), ...Object.keys(preludeFns({}))],
    knownChains: reg.ids(),
    fnSignals: {
      'genesis.spec': ['spec.ready', 'spec.invalid'],
      'genesis.scaffold': ['scaffold.done'],
      'genesis.lint': ['lint.pass', 'lint.fail'],
      'genesis.applyPatch': ['patch.applied'],
      'genesis.dryRun': ['dryrun.ok', 'dryrun.fail'],
      'genesis.write': ['write.done', 'write.skipped'],
      'genesis.report': ['genesis.done', 'chain.end'],
      'userStore': ['user.stored', 'user.storeFailed'],
      'userRead': ['user.read', 'user.readFailed'],
      'prelude.snapshot': ['prelude.snapshot'],
      'prelude.govern': ['prelude.govern'],
      'prelude.done': ['prelude.done'],
    },
  });

  console.log(`\n${C.b}自举：构造元链 sys.genesis${C.x}`);
  console.log(`  节点 ${res.summary.nodes} · 可达 ${res.summary.reachable} · 孤儿 ${res.summary.orphans} · 环路 ${res.summary.cycles} · 终止节点 ${res.summary.terminators}`);
  console.log(`  自检：${res.ok ? C.g + '通过' : C.r + '未通过'}${C.x} · 评分 ${res.score}`);
  if (res.findings.length) console.log(formatFindings(res));

  if (!res.ok && !args.flags.force) {
    console.log(`\n${C.r}元链自身未通过检查，已中止写入。用 --force 强制写入。${C.x}`);
    process.exitCode = 1;
    return;
  }

  const file = reg.save(chain);
  console.log(`\n${C.g}✓${C.x} 已写入 ${path.relative(ROOT, file)}`);
  console.log(`${C.dim}  下一步：node src/cli.js new "帮我造一条信息提取链"${C.x}\n`);
}

/* ------------------------------------------------------------------ */
async function cmdNew(args) {
  const goal = args._[0] || args.flags.goal;
  if (!goal) { console.log(`${C.r}用法：ajtc new "<建链需求>" [--id gen.xxx] [--mock]${C.x}`); process.exitCode = 1; return; }

  const reg = new Registry(path.join(ROOT, 'chains')).load();
  if (!reg.has('sys.genesis')) {
    console.log(`${C.y}元链未初始化，正在自动执行 init…${C.x}`);
    cmdInit({ flags: {} });
    reg.load();
  }

  const adapter = makeAdapter();
  const tracer = new Tracer({ level: args.flags.log || 'info' });
  const kernel = new Kernel({
    chain: reg.get('sys.genesis'),
    adapter,
    tracer,
    loadChain: reg.loader(),
    fns: { ...builtins, ...genesisFns({ registry: reg }), ...preludeFns({}) },
  });

  const input = {
    goal,
    chainId: args.flags.id || null,
    domain: args.flags.domain || 'general',
    stages: args.flags.stages ? Number(args.flags.stages) : null,
    qualityGate: args.flags['no-gate'] ? false : true,
    constraints: args.flags.constraint ? [args.flags.constraint] : [],
    acceptance: [],
  };

  console.log(`\n${C.b}▶ 建链：${goal}${C.x}\n`);
  const result = await kernel.run(input);
  const report = result.blackboard.output;

  console.log('');
  if (!report) {
    console.log(`${C.r}未产出报告。终止原因：${result.haltReason}${C.x}`);
    process.exitCode = 1;
    return;
  }

  printGenesisReport(report);
  if (args.flags.out) fs.writeFileSync(args.flags.out, JSON.stringify(report, null, 2), 'utf8');
  if (!report.approved) process.exitCode = 1;
}

function printGenesisReport(r) {
  const okmark = r.approved ? `${C.g}✓ 已生成并落盘${C.x}` : `${C.r}✖ 未通过，未落盘${C.x}`;
  console.log(`${C.b}════ 建链报告 ════${C.x}`);
  console.log(`  结果    ${okmark}`);
  console.log(`  链 id   ${C.c}${r.chainId}${C.x}   ${r.title || ''}`);
  console.log(`  意图    ${r.intent || '-'}`);
  if (r.file) console.log(`  文件    ${path.relative(ROOT, r.file)}`);
  console.log(`  静态检查 ${r.lint.passed ? C.g + '通过' : C.r + '未通过'}${C.x} · 评分 ${r.lint.score} · 修复轮次 ${r.lint.rounds}`);
  console.log(`  空跑验证 ${r.dryRun.passed ? C.g + '通过' : C.r + '未通过'}${C.x} · ${r.dryRun.steps} 步 / ${r.dryRun.llmCalls} 次模型调用 · ${r.dryRun.haltReason || '-'}`);
  console.log(`\n  ${C.b}节点拓扑${C.x}`);
  for (const n of r.nodes || []) {
    console.log(`    ${C.dim}${(n.on || []).join(',').padEnd(30)}${C.x} → ${C.c}${n.id.padEnd(14)}${C.x} ${C.dim}[${n.kind}${n.role ? '/' + n.role : ''}]${C.x} ⇒ ${(n.declares || []).join(', ') || '-'}`);
  }
  if ((r.lint.remaining || []).length) {
    console.log(`\n  ${C.y}遗留问题${C.x}`);
    for (const f of r.lint.remaining) console.log(`    [${f.rule}] ${f.where} — ${f.msg}`);
  }
  if ((r.nextActions || []).length) {
    console.log(`\n  ${C.b}下一步${C.x}`);
    for (const a of r.nextActions) console.log(`    · ${a}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ */
function cmdLint(args) {
  const ref = args._[0];
  if (!ref) { console.log(`${C.r}用法：ajtc lint <链id|文件>${C.x}`); process.exitCode = 1; return; }
  const reg = new Registry(path.join(ROOT, 'chains')).load();
  const chain = reg.get(ref);
  const res = lint(chain, {
    knownFns: [...Object.keys(builtins), ...Object.keys(genesisFns({ registry: reg })), ...Object.keys(preludeFns({}))],
    knownChains: reg.ids(),
    fnSignals: {
      'genesis.spec': ['spec.ready', 'spec.invalid'],
      'genesis.scaffold': ['scaffold.done'],
      'genesis.lint': ['lint.pass', 'lint.fail'],
      'genesis.applyPatch': ['patch.applied'],
      'genesis.dryRun': ['dryrun.ok', 'dryrun.fail'],
      'genesis.write': ['write.done', 'write.skipped'],
      'genesis.report': ['genesis.done', 'chain.end'],
      'userStore': ['user.stored', 'user.storeFailed'],
      'userRead': ['user.read', 'user.readFailed'],
      'prelude.snapshot': ['prelude.snapshot'],
      'prelude.govern': ['prelude.govern'],
      'prelude.done': ['prelude.done'],
    },
  });
  if (args.flags.json) { console.log(JSON.stringify(res, null, 2)); return; }
  console.log(`\n${C.b}检查 ${chain.id}${C.x} · ${chain.title}`);
  console.log(`  ${JSON.stringify(res.summary)}`);
  if (res.gates) {
    console.log(`  验收门：功能=${fmtGate(res.gates.functional)} 静态=${fmtGate(res.gates.static)} 性能=${fmtGate(res.gates.performance)} 安全=${fmtGate(res.gates.security)} 回归=${fmtGate(res.gates.regression)} 治理=${fmtGate(res.gates.governance)}`);
  }
  console.log(`  结论：${res.ok ? C.g + '通过' : C.r + '未通过'}${C.x} · 评分 ${res.score}\n`);
  console.log(formatFindings(res));
  console.log('');
  if (!res.ok) process.exitCode = 1;
}

function fmtGate(g) {
  if (!g) return '?';
  return g.passed ? `${C.g}✓${C.x}` : `${C.y}▲${C.x}`;
}

/* ------------------------------------------------------------------ */
async function cmdRun(args) {
  const ref = args._[0];
  if (!ref) { console.log(`${C.r}用法：ajtc run <链id|文件> --goal "..." | --input x.json${C.x}`); process.exitCode = 1; return; }
  const reg = new Registry(path.join(ROOT, 'chains')).load();
  const chain = reg.get(ref);
  const input = readInput(args.flags) || { goal: `运行 ${chain.title}` };

  const tracer = new Tracer({ level: args.flags.log || 'info' });
  const kernel = new Kernel({
    chain,
    adapter: makeAdapter(),
    tracer,
    loadChain: reg.loader(),
    fns: { ...builtins, ...genesisFns({ registry: reg }), ...preludeFns({}) },
  });

  console.log(`\n${C.b}▶ 运行 ${chain.id}${C.x} · ${chain.title}\n`);
  const res = await kernel.run(input);
  const out = res.blackboard.output ?? res.blackboard;

  console.log(`\n${C.b}════ 运行结果 ════${C.x}`);
  console.log(`  终止原因 ${res.haltReason || '事件队列耗尽'}`);
  console.log(`  预算     ${res.budget.used.steps} 步 / ${res.budget.used.llmCalls} 次模型调用 / ${res.budget.used.elapsedMs}ms`);
  console.log(`  问题     ${(res.blackboard._issues || []).length} 条`);
  if (args.flags.json) console.log(JSON.stringify(out, null, 2));
  else console.log(`\n${JSON.stringify(out, null, 2).split('\n').slice(0, 60).join('\n')}`);
  if (args.flags.out) { fs.writeFileSync(args.flags.out, JSON.stringify(res, null, 2), 'utf8'); console.log(`\n结果已写入 ${args.flags.out}`); }
  console.log('');
}

/* ------------------------------------------------------------------ */
/**
 * 通用影子回放核（参数即契约）。
 *  - adapter:   LLM 适配器（本插件固定为 MockAdapter，确定性、可复现、零外部依赖）
 *  - noopFns:   手动指定副作用 noop 集（覆盖默认）；默认 = 链节点 sideEffect:true ∪ recording.sideEffects
 *  - record:    仅录制基线（input + 副作用节点清单），不跑真实副作用
 *  - diff:      比对两份回放报告的一致性闸门
 * 副作用隔离以「链节点 sideEffect:true 声明」为权威来源：回放时永远按链定义 noop，
 * 即使录制文件漏列也不会静默真写盘；另加命名启发式告警兜底（绝不擅自断链）。
 */
function looksSideEffecting(name) {
  if (!name) return false;
  for (const h of SIDE_EFFECT_HINTS) if (name.includes(h)) return true;
  return false;
}

async function runShadow({ ref, baseline, out, log, adapter, noopFns, record, inputFile, mode, diff, diffA, diffB }) {
  // ---- --diff：一致性闸门（无需加载链）----
  if (diff) {
    const readR = (f) => JSON.parse(fs.readFileSync(path.isAbsolute(f) ? f : path.resolve(process.cwd(), f), 'utf8'));
    const a = readR(diffA), b = readR(diffB);
    const q = (r) => (r && r.output && r.output.quality) || null;
    const qA = q(a), qB = q(b);
    const structSame = a.steps === b.steps && a.llmCalls === b.llmCalls && a.halted === b.halted && a.haltReason === b.haltReason;
    let verdict;
    if (qA && qB) verdict = (structSame && JSON.stringify(qA) === JSON.stringify(qB)) ? 'PASS' : 'DRIFT';
    else if (qA || qB) verdict = 'INCONCLUSIVE';
    else verdict = structSame ? 'PASS(struct-only)' : 'DRIFT(struct)';
    console.log(`\n${C.b}▶ 影子回放一致性闸门 diff${C.x}`);
    console.log(`  A=${path.basename(diffA)}  B=${path.basename(diffB)}`);
    console.log(`  结构一致=${structSame} (steps ${a.steps}/${b.steps}, llm ${a.llmCalls}/${b.llmCalls}, halted ${a.halted}/${b.halted})`);
    console.log(`  质量一致=${qA && qB ? (JSON.stringify(qA) === JSON.stringify(qB)) : 'N/A（mock 模式无真实 quality，仅结构一致性可比对）'}`);
    console.log(`  ${verdict.startsWith('PASS') ? C.g : C.r}结论=${verdict}${C.x}\n`);
    return { verdict, structSame, qA, qB };
  }

  const reg = new Registry(path.join(ROOT, 'chains')).load();
  const chain = reg.get(ref);
  if (!chain) { console.log(`${C.r}未找到链 ${ref}${C.x}`); process.exitCode = 1; return null; }

  // 链侧副作用声明（权威来源）
  const chainSideFx = (chain.nodes || []).filter((n) => n.sideEffect === true && n.use).map((n) => n.use);

  // ---- --record：仅录制基线 ----
  if (record) {
    let input = {};
    if (inputFile) {
      const p = path.isAbsolute(inputFile) ? inputFile : path.resolve(process.cwd(), inputFile);
      input = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    const rec = {
      chainId: chain.id,
      runId: `rec-${Date.now()}`,
      recordedAt: new Date().toISOString(),
      input,
      sideEffects: chainSideFx,
      mode: mode || 'mock',
      recordedWith: 'ajtc shadow --record',
    };
    const dir = path.join(SHADOW_DIR, chain.id);
    fs.mkdirSync(dir, { recursive: true });
    const recPath = path.join(dir, `${rec.runId}.json`);
    fs.writeFileSync(recPath, JSON.stringify(rec, null, 2), 'utf8');
    console.log(`\n${C.b}▶ 录制基线 ${chain.id}${C.x}`);
    console.log(`  副作用节点（回放将自动 noop）：${chainSideFx.join(', ') || '无'}`);
    console.log(`  基线已写入 ${path.relative(ROOT, recPath)}\n`);
    if (out) fs.writeFileSync(out, JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  }

  // ---- 回放 ----
  const p = path.isAbsolute(baseline) ? baseline : path.resolve(process.cwd(), baseline);
  const recording = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tracer = new Tracer({ level: log || 'info' });
  const resolvedAdapter = adapter || new MockAdapter({ latency: 0 });
  // noop 集：--noop 手动覆盖 > (链声明 ∪ recording 声明)
  const baseSet = new Set([...chainSideFx, ...(recording.sideEffects || [])]);
  const noopSet = noopFns ? new Set(noopFns) : baseSet;
  const sideEffectNoop = {};
  for (const name of noopSet) sideEffectNoop[name] = () => ({ data: { skipped: name }, signals: [] });
  const initial = recording.input !== undefined ? { '$.input': recording.input } : {};
  const kernel = new Kernel({
    chain,
    adapter: resolvedAdapter,
    tracer,
    blackboard: new Blackboard(initial),
    loadChain: reg.loader(),
    fns: { ...builtins, ...genesisFns({ registry: reg }), ...preludeFns({}), ...sideEffectNoop },
    preChain: false,
  });

  console.log(`\n${C.b}▶ 影子回放 ${chain.id}${C.x} · baseline=${path.basename(p)} · mode=${mode || 'mock'}\n`);
  const res = await kernel.run(recording.input);

  // 启发式告警：疑似副作用但未声明/未 noop 的 fn 节点
  const mounted = { ...builtins, ...genesisFns({ registry: reg }) };
  const unannotated = (chain.nodes || [])
    .filter((n) => n && n.kind === 'fn' && n.use && !noopSet.has(n.use) && mounted[n.use] && looksSideEffecting(n.use))
    .map((n) => n.use);
  if (unannotated.length) {
    console.log(`${C.y}⚠ 以下 fn 节点疑似副作用但未声明 sideEffect:true，回放可能真写盘！建议给节点加 "sideEffect": true：${unannotated.join(', ')}${C.x}`);
  }

  const outObj = res.blackboard.output ?? null;
  const report = {
    chainId: chain.id,
    replayedAt: new Date().toISOString(),
    baseline: path.basename(p),
    mode: mode || 'mock',
    steps: res.budget.used.steps,
    llmCalls: res.budget.used.llmCalls,
    elapsedMs: res.budget.used.elapsedMs,
    halted: res.halted,
    haltReason: res.haltReason,
    output: outObj,
    quality: (outObj && outObj.quality) || null,
    sideEffectsSkipped: [...noopSet],
  };
  const outPath = path.join(SHADOW_DIR, `${chain.id}-replay-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`  步数 ${report.steps} · LLM ${report.llmCalls} · ${report.elapsedMs}ms`);
  console.log(`  副作用已跳过（noop）：${(report.sideEffectsSkipped || []).join(', ') || '无'}`);
  console.log(`  回放报告已写入 ${path.relative(ROOT, outPath)}\n`);
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

async function cmdShadow(args) {
  // --diff：比对两份回放报告
  if (args.flags.diff) {
    const files = args._;
    if (files.length < 2) { console.log(`${C.r}用法：ajtc shadow --diff <报告A.json> <报告B.json>${C.x}`); process.exitCode = 1; return; }
    await runShadow({ diff: true, diffA: files[0], diffB: files[1], log: args.flags.log });
    return;
  }
  const ref = args._[0];
  if (!ref) {
    console.log(`${C.r}用法：ajtc shadow <链id> [--record --input x.json] | [--baseline <rec.json> [--noop fn1,fn2]]${C.x}`);
    process.exitCode = 1; return;
  }
  // --record：仅录制基线
  if (args.flags.record) {
    await runShadow({ ref, record: true, inputFile: args.flags.input, mode: args.flags.mode, out: args.flags.out, log: args.flags.log });
    return;
  }
  // 回放
  const baseline = args.flags.baseline;
  if (!baseline) { console.log(`${C.r}需指定 --baseline <recording.json>（或先用 --record 录制）${C.x}`); process.exitCode = 1; return; }
  const noopFns = args.flags.noop ? args.flags.noop.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  await runShadow({ ref, baseline, out: args.flags.out, log: args.flags.log, noopFns, mode: args.flags.mode });
}

/* ------------------------------------------------------------------ */
function cmdList() {
  const reg = new Registry(path.join(ROOT, 'chains')).load();
  const idx = reg.index();
  console.log(`\n${C.b}已注册的链（${idx.length}）${C.x}`);
  if (!idx.length) console.log(`  ${C.dim}（空。先运行 node src/cli.js init）${C.x}`);
  for (const c of idx) {
    console.log(`  ${C.c}${c.id.padEnd(24)}${C.x} ${String(c.nodes).padStart(2)} 节点  ${c.title}`);
    if (c.intent) console.log(`  ${' '.repeat(24)} ${C.dim}${c.intent.slice(0, 90)}${C.x}`);
  }
  if (reg.errors.length) {
    console.log(`\n${C.r}加载失败的文件${C.x}`);
    for (const e of reg.errors) console.log(`  ${e.file}: ${e.error}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ */
function cmdViz(args) {
  const reg = new Registry(path.join(ROOT, 'chains')).load();
  const chain = reg.get(args._[0]);
  const res = lint(chain, {});
  console.log(`\n${C.b}${chain.id}${C.x} · ${chain.title}`);
  console.log(`${C.dim}${chain.intent || ''}${C.x}\n`);

  const byId = new Map(chain.nodes.map((n) => [n.id, n]));
  const incoming = new Map();
  for (const e of res.graph.edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e);
  }

  console.log(`  ${C.dim}chain.start${C.x}`);
  for (const n of chain.nodes) {
    const ins = (incoming.get(n.id) || []).map((e) => `${e.from}:${e.via}`);
    const entry = (n.trigger || []).some((t) => t.on === 'chain.start');
    const arrow = entry ? '┌─▶' : '│  ';
    const kindTag = { llm: '🧠', fn: '⚙', gate: '◇', map: '⇉', chain: '⧉', loop: '↻' }[n.kind] || '·';
    console.log(`  ${arrow} ${kindTag} ${C.c}${n.id.padEnd(14)}${C.x} ${(n.title || '').padEnd(18)} ${C.dim}${n.role ? '[' + n.role + ']' : ''}${C.x}`);
    if (ins.length) console.log(`  │      ${C.dim}◀ ${ins.join('  ◀ ')}${C.x}`);
    const outs = (res.graph.edges.filter((e) => e.from === n.id));
    if (outs.length) console.log(`  │      ${C.dim}▶ ${outs.map((e) => `${e.via} → ${e.to}`).join('   ')}${C.x}`);
    if (n.halt) console.log(`  └──── ${C.g}HALT${C.x}`);
  }
  console.log(`\n  节点 ${res.summary.nodes} · 可达 ${res.summary.reachable} · 环路 ${res.summary.cycles} · 检查${res.ok ? C.g + '通过' : C.r + '未通过'}${C.x}\n`);
}

/* ------------------------------------------------------------------ */
function cmdRoles() {
  console.log(`\n${C.b}可用角色模板（${Object.keys(ROLES).length}）${C.x}\n`);
  for (const [k, v] of Object.entries(ROLES)) {
    console.log(`  ${C.c}${k.padEnd(22)}${C.x} ${C.dim}⇒ ${(v.signals || []).join(' / ')}${C.x}`);
    console.log(`  ${' '.repeat(22)} ${v.duty}`);
  }
  console.log('');
}

/* ------------------------------------------------------------------ */
const HELP = `
${C.b}ajtc${C.x} — AI JSON 触发链系统

  ${C.c}init${C.x} [--force]              自举：构造并写入元链 sys.genesis
  ${C.c}new${C.x} "<建链需求>" [选项]       用元链生成一条新链
  ${C.c}lint${C.x} <链id|文件> [--json]     静态检查（23 条规则 L001–L023 / L025）
  ${C.c}run${C.x} <链id|文件> [选项]        运行一条链
  ${C.c}list${C.x}                        列出已注册的链
  ${C.c}viz${C.x} <链id>                   打印链路图
  ${C.c}roles${C.x}                       列出角色模板

选项
  --mock              强制离线 mock 模型
  --goal "<text>"     直接给一句目标
  --input <file>      JSON 输入文件
  --id <chainId>      指定新链 id
  --stages <n>        期望阶段数
  --no-gate           不生成质量门与迭代回路
  --log <level>       debug|info|warn|error
  --json / --out <f>  JSON 输出 / 写入文件

模型：本插件仅内置离线 mock 适配器（确定性、可复现、零外部依赖），无 API Key 概念。
记忆后端（TencentDB Agent-Memory / 本地）经环境变量切换，详见 README 与 engine/.env.example。
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  try {
    switch (cmd) {
      case 'init': return cmdInit(args);
      case 'new': return await cmdNew(args);
      case 'lint': return cmdLint(args);
      case 'run': return await cmdRun(args);
      case 'shadow': return await cmdShadow(args);
      case 'list': return cmdList();
      case 'viz': return cmdViz(args);
      case 'roles': return cmdRoles();
      default: console.log(HELP);
    }
  } catch (e) {
    console.error(`\n${C.r}✖ ${e.message}${C.x}\n`);
    if (args.flags.log === 'debug') console.error(e.stack);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main };
