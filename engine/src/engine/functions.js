'use strict';
/**
 * functions.js —— 内置「确定性节点」函数库
 *
 * 触发链里不是所有节点都该交给模型。凡是能用代码确定性算出来的（合并、断言、
 * 打分、收敛判定、计数、打包），一律用函数节点。这样能大幅降低 token 成本，
 * 并且让链路的骨架是可测的。
 *
 * 约定：fn(args, ctx) -> { data, signals?, issues?, confidence? }
 *   args  已经过表达式解析的输入对象
 *   ctx   { bb, tracer, node, event, evaluate }
 */

const { evaluate, truthy } = require('./expr');
const fs = require('fs');
const path = require('path');
const os = require('os');

const builtins = {
  noop: (args) => ({ data: args || {}, signals: ['noop.done'] }),
  agentStep: (args, ctx) => {
    const nodeId = (ctx && ctx.node && ctx.node.id) || 'agentStep';
    const action = (args && (args.action || args.a)) || '';
    const visible = (args && (args.visible || args.v)) || action;
    const status = (args && args.status) || 'agent-pending';
    const resultPath = (args && args.resultPath) || `$.agentSteps.${nodeId}`;
    const rec = { nodeId, action, visible, status, ts: new Date().toISOString() };
    if (ctx && ctx.bb) {
      const arr = ctx.bb.get('$.agentSteps') || [];
      arr.push(rec);
      ctx.bb.set('$.agentSteps', arr);
      ctx.bb.set(resultPath, rec);
    }
    const issues = action
      ? []
      : [{ severity: 'medium', where: `$.agentSteps.${nodeId}`, msg: 'agentStep 缺少 action，无法驱动代理执行外部动作' }];
    const signal = (args && args.emit) ? (Array.isArray(args.emit) ? args.emit : [args.emit]) : [`${nodeId}.done`];
    return { data: { rec, resultPath }, signals: signal, issues };
  },
  intake: (args, ctx) => {
    const raw = args.raw ?? ctx.bb.get('$.input') ?? {};
    const goal = raw.goal || raw.task || raw.question || (typeof raw === 'string' ? raw : '');
    const data = {
      goal: String(goal || '').trim(),
      path: raw.path || raw.projectPath || (typeof raw === 'string' ? '' : ''),
      domain: raw.domain || 'general',
      context: raw.context || '',
      constraints: Array.isArray(raw.constraints) ? raw.constraints : (raw.constraints ? [raw.constraints] : []),
      successCriteria: Array.isArray(raw.successCriteria) ? raw.successCriteria : (raw.successCriteria ? [raw.successCriteria] : []),
      boundaries: Array.isArray(raw.boundaries) ? raw.boundaries : (raw.boundaries ? [raw.boundaries] : []),
      artifacts: raw.artifacts || {},
      acceptance: Array.isArray(raw.acceptance) ? raw.acceptance : [],
      mode: raw.mode || 'auto',
      receivedAt: new Date().toISOString(),
    };
    const issues = [];
    if (!data.goal && !data.path) issues.push({ severity: 'high', where: '$.input', msg: '缺少目标描述与项目路径，后续链路无法定向' });
    return { data, issues, signals: issues.length ? ['intake.invalid'] : ['intake.ready'] };
  },
  set: (args) => ({ data: args.values || args, signals: ['set.done'] }),
  merge: (args) => {
    const list = Array.isArray(args.sources) ? args.sources : [];
    let out = args.seed && typeof args.seed === 'object' ? { ...args.seed } : {};
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      for (const [k, v] of Object.entries(s)) {
        if (Array.isArray(out[k]) && Array.isArray(v)) out[k] = out[k].concat(v);
        else if (out[k] && typeof out[k] === 'object' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...out[k], ...v };
        else out[k] = v;
      }
    }
    return { data: out, signals: ['merge.done'] };
  },
  collect: (args) => {
    const items = (Array.isArray(args.items) ? args.items : []).filter((x) => x !== undefined && x !== null);
    return { data: { items, count: items.length }, signals: ['collect.done'] };
  },
  assert: (args, ctx) => {
    const conds = Array.isArray(args.conditions) ? args.conditions : [];
    const issues = [];
    for (const c of conds) {
      let pass = false;
      try { pass = truthy(evaluate(c.expr, ctx.exprCtx)); }
      catch (e) { pass = false; issues.push({ severity: 'high', where: c.expr, msg: `断言表达式求值失败：${e.message}` }); continue; }
      if (!pass) issues.push({ severity: c.severity || 'high', where: c.where || c.expr, msg: c.msg || `断言未通过：${c.expr}` });
    }
    const failed = issues.length > 0;
    return {
      data: { passed: !failed, total: conds.length, failedCount: issues.length, issues },
      issues,
      signals: failed ? ['assert.failed'] : ['assert.passed'],
    };
  },
  score: (args) => {
    const weights = args.weights || {};
    const cands = Array.isArray(args.candidates) ? args.candidates : [];
    const scored = cands.map((c) => {
      const m = c.metrics || c;
      let s = 0, wsum = 0;
      for (const [k, w] of Object.entries(weights)) {
        const v = Number(m[k]);
        if (!Number.isFinite(v)) continue;
        s += v * w; wsum += Math.abs(w);
      }
      return { ...c, score: wsum ? +(s / wsum).toFixed(4) : 0 };
    }).sort((a, b) => b.score - a.score);
    const topK = Number(args.topK) || scored.length;
    return {
      data: { ranked: scored, top: scored.slice(0, topK), best: scored[0] || null },
      signals: scored.length ? ['score.done'] : ['score.empty'],
    };
  },
  slice: (args) => {
    const arr = Array.isArray(args.list) ? args.list : [];
    return { data: { items: arr.slice(0, Number(args.n) || 5) }, signals: ['slice.done'] };
  },
  counter: (args, ctx) => {
    const path = args.path || '$._counters.default';
    const cur = Number(ctx.bb.get(path, 0)) + (Number(args.step) || 1);
    ctx.bb.set(path, cur);
    const limit = Number(args.limit) || Infinity;
    return { data: { value: cur, limit, exhausted: cur >= limit }, signals: cur >= limit ? ['counter.exhausted'] : ['counter.tick'] };
  },
  diff: (args) => {
    const a = args.before, b = args.after;
    const changes = [];
    const walk = (x, y, p) => {
      const tx = Array.isArray(x) ? 'array' : typeof x;
      const ty = Array.isArray(y) ? 'array' : typeof y;
      if (tx !== ty) { changes.push({ path: p, type: 'type', from: tx, to: ty }); return; }
      if (tx === 'object' && x && y) {
        const keys = new Set([...Object.keys(x || {}), ...Object.keys(y || {})]);
        for (const k of keys) {
          if (!(k in (x || {}))) changes.push({ path: `${p}.${k}`, type: 'add' });
          else if (!(k in (y || {}))) changes.push({ path: `${p}.${k}`, type: 'remove' });
          else walk(x[k], y[k], `${p}.${k}`);
        }
      } else if (tx === 'array') {
        if ((x || []).length !== (y || []).length) changes.push({ path: p, type: 'length', from: (x || []).length, to: (y || []).length });
        for (let i = 0; i < Math.min((x || []).length, (y || []).length); i++) walk(x[i], y[i], `${p}[${i}]`);
      } else if (x !== y) {
        changes.push({ path: p, type: 'modify', from: x, to: y });
      }
    };
    walk(a, b, '$');
    return { data: { changed: changes.length > 0, count: changes.length, changes: changes.slice(0, 200) }, signals: changes.length ? ['diff.changed'] : ['diff.same'] };
  },
  converge: (args) => {
    const hist = (Array.isArray(args.history) ? args.history : []).map(Number).filter(Number.isFinite);
    const round = Number(args.round) || hist.length;
    const maxRounds = Number(args.maxRounds) || 3;
    const minDelta = Number(args.minDelta) ?? 0.02;
    const target = args.target != null ? Number(args.target) : null;

    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    const delta = (Number.isFinite(last) && Number.isFinite(prev)) ? +(last - prev).toFixed(4) : null;

    let reason = null;
    if (target != null && Number.isFinite(last) && last >= target) reason = `已达目标分 ${target}`;
    else if (round >= maxRounds) reason = `达到最大轮次 ${maxRounds}`;
    else if (delta != null && delta < minDelta) reason = `本轮增益 ${delta} 低于阈值 ${minDelta}，收益递减`;

    const converged = reason != null;
    return {
      data: { converged, reason, round, maxRounds, last, prev, delta, history: hist },
      signals: converged ? ['iterate.converged'] : ['iterate.continue'],
    };
  },
  groupBy: (args) => {
    const arr = Array.isArray(args.list) ? args.list : [];
    const key = args.key || 'type';
    const groups = {};
    for (const it of arr) {
      const k = String(it?.[key] ?? 'unknown');
      (groups[k] = groups[k] || []).push(it);
    }
    return { data: { groups, keys: Object.keys(groups) }, signals: ['group.done'] };
  },
  traceStats: (args, ctx) => {
    const stats = ctx.tracer.stats();
    return { data: stats, signals: ['trace.ready'] };
  },
  deliver: (args, ctx) => {
    const artifacts = args.artifacts || {};
    const quality = args.quality || {};
    const completionPackage = args.completionPackage || {
      scope: '本次链运行产出',
      designNote: '见各节点 artifacts 与 review 意见',
      risks: (quality && quality.weaknesses) ? quality.weaknesses.map((w) => w.msg) : [],
      acceptanceCommand: `node src/cli.js run ${ctx.chain.id} --goal "${ctx.bb.get('$.intake.goal') || ''}"`,
      verificationResults: { lint: quality && quality.score != null ? `score ${quality.score}` : '未启用质量门', trace: { runId: ctx.tracer.runId, steps: ctx.tracer.records.length } },
      regressionNote: '如需回归测试，请在链中增加 test-executor 节点或保留 golden output',
      openItems: [],
      nextSteps: ['根据 review 意见迭代', '补充回归测试', '用 gen.chain-governance 定期审查'],
    };
    const payload = {
      goal: ctx.bb.get('$.intake.goal'),
      answer: args.answer ?? ctx.bb.get('$.generate.draft') ?? ctx.bb.get('$.summary'),
      artifacts,
      quality,
      completionPackage,
      trace: { runId: ctx.tracer.runId, steps: ctx.tracer.records.length },
      finishedAt: new Date().toISOString(),
    };
    return { data: payload, signals: ['deliver.done', 'chain.end'] };
  },
  briefing: (args, ctx) => {
    const goal = ctx.bb.get('$.intake.goal') || '';
    const review = ctx.bb.get('$.review') || {};
    const dims = Array.isArray(review.dimensions) ? review.dimensions : [];
    const gates = (ctx.bb.get('$.evidence.gates')) || {};
    const weaknesses = Array.isArray(review.weaknesses) ? review.weaknesses : [];
    const suggestions = Array.isArray(review.suggestions) ? review.suggestions : [];
    const passageTitle = ctx.bb.get('$.revised.patched.title')
      || ctx.bb.get('$.weave.title')
      || '(无标题)';
    const md = [
      '# 执行简报 · 叙述层',
      '',
      `**目标**：${goal || '(空)'}`,
      `**产出标题**：${passageTitle}`,
      `**评审总分**：${typeof review.score === 'number' ? review.score.toFixed(2) : '—'}`,
      '',
      '## 评审维度',
      ...(dims.length ? dims.map((d) => `- ${d.id}: ${typeof d.score === 'number' ? d.score.toFixed(2) : '?'} ${d.comment ? '— ' + d.comment : ''}`) : ['- (无维度数据)']),
      '',
      '## 验收门（机器判定）',
      ...Object.entries(gates).map(([k, v]) => `- ${k}: ${v}`),
      '',
      '## 风险与待办',
      ...(weaknesses.length ? weaknesses.map((w) => `- [${w.severity || '?'}] ${w.msg || ''}`) : ['- 无']),
      '',
      '## 下一步',
      ...(suggestions.length ? suggestions.map((s) => `- ${s}`) : ['- 按评审意见迭代']),
    ].join('\n');
    return { data: { markdown: md, summary: passageTitle, layer: 'narrative' }, issues: [], signals: ['briefing.done'] };
  },
  archive: (args, ctx) => {
    const fs = require('fs');
    const path = require('path');
    const runId = (ctx.tracer && ctx.tracer.runId) ? ctx.tracer.runId : 'unknown';
    const goal = ctx.bb.get('$.intake.goal') || '';
    const review = ctx.bb.get('$.review') || {};
    const manifestProducts = (ctx.bb.get('$.evidenceManifest.manifest.products')) || [];
    const weaknesses = Array.isArray(review.weaknesses) ? review.weaknesses : [];
    const md = [
      '# 运行归档 · 决策与风险',
      '',
      `runId: ${runId}`,
      `chainVersion: ${(ctx.kernel && ctx.kernel.chain && ctx.kernel.chain.version) || ctx.chain.version || 'unknown'}`,
      `goal: ${goal || '(空)'}`,
      '',
      '## 设计 / 决策',
      '- 治理骨架：战略层（intent/principle/acceptance/redlines/boundaries）由人设定；战术层 AI 在边界内执行；裁决层 5 道门（功能/静态/安全/风格/回归）机器判定。',
      '- 核心红线贯穿规划/实现/评审/修订全流程，越界即 score 封顶 0.3。',
      '',
      '## 变更',
      `- 本轮运行触达产物见 evidence-manifest：${manifestProducts.join(', ') || '(未生成)'}`,
      '',
      '## 风险',
      ...(weaknesses.length ? weaknesses.map((w) => `- [${w.severity || '?'}] ${w.msg || ''}`) : ['- 无']),
      '',
      '## 验收',
      `- 评审总分：${typeof review.score === 'number' ? review.score.toFixed(2) : '—'}`,
    ].join('\n');
    let archivePath = null;
    try {
      const dir = path.resolve(process.cwd(), 'run-output', runId);
      fs.mkdirSync(dir, { recursive: true });
      archivePath = path.join(dir, 'archive.md');
      fs.writeFileSync(archivePath, md, 'utf8');
    } catch (e) {
      return { data: { archivePath: null, error: e.message }, issues: [{ severity: 'medium', where: 'archive', msg: '归档写盘失败：' + e.message }], signals: ['archive.done'] };
    }
    return { data: { archivePath }, issues: [], signals: ['archive.done'] };
  },
  redlines: (args, ctx) => {
    // 不是每条链都有 intake 归一化节点（memory.store 的入口就是 llm）。
    // 取不到 $.intake 时回落到原始 $.input，否则红线门会因为读到空串而「静默全过」——
    // 一道永远通过的门比没有门更危险，因为它会让人以为已经查过了。
    const raw = ctx.bb.get('$.intake') || ctx.bb.get('$.input') || {};
    const intake = typeof raw === 'string' ? { goal: raw } : raw;
    const goal = String(intake.goal || '');
    const context = String(intake.context || '');
    const text = `${goal}\n${context}`.toLowerCase();
    const successCriteria = Array.isArray(intake.successCriteria) ? intake.successCriteria : [];
    const acceptance = Array.isArray(intake.acceptance) ? intake.acceptance : [];

    const kws = (Array.isArray(args.boundaryKeywords) && args.boundaryKeywords.length
      ? args.boundaryKeywords
      : []).map((k) => String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const boundaryRe = new RegExp(
      `(?:修改|混用|覆盖|侵入|删除|迁移).*(?:${kws.join('|')})|破坏.*边界|覆盖.*公司.*项目`, 'i');

    const checks = [
      { id: 'defineSuccess', rule: 'AI 不能单方定义成功标准', re: /你定.*标准|AI决定.*成功|不用验收|取消验收|忽略.*标准/i, passed: true },
      { id: 'fakeEvidence', rule: 'AI 不能伪造证据', re: /伪造.*证据|假数据|虚拟.*数据|造.*结果|ps.*图|篡改.*日志|fake.*evidence/i, passed: true },
      { id: 'skipGates', rule: '不能跳过验收门', re: /跳过.*验收|跳过.*测试|不要.*review|不用.*assert|绕过.*检查|忽略.*质量门|skip.*gate/i, passed: true },
      { id: 'breakBoundary', rule: `不能破坏边界（${kws.join('/')}）`, re: boundaryRe, passed: true },
      { id: 'loseEvidence', rule: '不能丢失证据', re: /删除.*日志|不保存.*证据|覆盖.*记录|清空.*trace|丢弃.*证据/i, passed: true },
    ];
    for (const r of Array.isArray(args.extraRules) ? args.extraRules : []) {
      if (!r || !r.pattern) continue;
      try {
        checks.push({ id: r.id || `custom${checks.length}`, rule: r.rule || r.id || '自定义红线', re: new RegExp(r.pattern, r.flags || 'i'), passed: true });
      } catch (e) {
        // 正则写错不能让整条链挂掉，降级为忽略并留痕
        if (ctx.tracer && ctx.tracer.warn) ctx.tracer.warn('redlines.badRule', `自定义红线正则非法：${r.pattern}`, { node: 'redlines' });
      }
    }
    const violations = [];
    for (const c of checks) {
      if (c.re.test(text)) violations.push({ id: c.id, rule: c.rule, matched: text.match(c.re)[0] });
    }
    // 若人未提供成功标准/验收条件，仅记录提醒，不失败（链头 acceptance 已作为人定默认标准）
    const missingCriteria = successCriteria.length === 0 && acceptance.length === 0;
    const issues = violations.map((v) => ({ severity: 'critical', where: 'redlines.' + v.id, msg: `触碰红线「${v.rule}」，命中指令片段：${v.matched}` }));
    if (missingCriteria) issues.push({ severity: 'medium', where: 'redlines.defineSuccess', msg: '未提供运行时 successCriteria 或 acceptance；将使用链头默认验收条件' });
    const data = {
      passed: violations.length === 0,
      violations,
      missingCriteria,
      checks: checks.map((c) => ({ id: c.id, rule: c.rule, safe: !violations.some((v) => v.id === c.id) })),
    };
    if (ctx.tracer && ctx.tracer.info) ctx.tracer.info(violations.length ? 'redlines.fail' : 'redlines.pass', `红线检查：${violations.length} 条违规`, { node: 'redlines' });
    return { data, issues, signals: [violations.length ? 'redlines.fail' : 'redlines.pass'] };
  },
  perfCheck: (args, ctx) => {
    const explore = ctx.bb.get('$.explore') || {};
    const services = Array.isArray(explore.services) ? explore.services : [];
    const withEndpoints = services.filter((s) => (s.endpointCount || 0) > 0);
    const withSrc = services.filter((s) => (s.srcFiles || 0) > 0);
    const maxEndpoints = withEndpoints.length ? Math.max(...withEndpoints.map((s) => s.endpointCount || 0)) : 0;
    const maxSrc = withSrc.length ? Math.max(...withSrc.map((s) => s.srcFiles || 0)) : 0;
    const totalEndpoints = withEndpoints.reduce((sum, s) => sum + (s.endpointCount || 0), 0);
    const totalSrc = withSrc.reduce((sum, s) => sum + (s.srcFiles || 0), 0);
    // 代码规模热点只认 codeFiles（.java/.ts/.vue 等），不能用 srcFiles ——
    // srcFiles 含 xml/yml 配置，会把「文档/配置多、代码极少」的模块误判成代码规模大。
    const sizeOf = (s) => (typeof s.codeFiles === 'number' ? s.codeFiles : (s.srcFiles || 0));
    const hotSpots = services
      .filter((s) => (s.endpointCount || 0) > 10 || sizeOf(s) > 100)
      .map((s) => ({
        name: s.name,
        endpointCount: s.endpointCount || 0,
        srcFiles: s.srcFiles || 0,
        codeFiles: sizeOf(s),
        reason: (s.endpointCount || 0) > 10 ? '接口密度高' : '代码规模大',
      }));
    let score = 1;
    if (maxEndpoints > 20) score -= 0.15;
    if (maxSrc > 300) score -= 0.1;
    if (totalSrc > 1000) score -= 0.05;
    score = Math.max(0, +score.toFixed(2));
    const data = { present: explore.exists === true, score, hotSpots, metrics: { maxEndpoints, maxSrc, totalEndpoints, totalSrc, serviceCount: services.length } };
    if (ctx.tracer && ctx.tracer.info) ctx.tracer.info('perfCheck.done', `性能检查：${services.length} 服务 / ${totalEndpoints} 接口 / score ${score}`, { node: 'perfCheck' });
    return { data, issues: [], signals: ['perfCheck.done'] };
  },
  evidence: (args, ctx) => {
    const crypto = require('crypto');
    const hash = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex').slice(0, 16);
    const runId = ctx.tracer && ctx.tracer.runId ? ctx.tracer.runId : 'unknown';
    const goal = ctx.bb.get('$.intake.goal') || '';

    const custom = args.artifacts && typeof args.artifacts === 'object' && !Array.isArray(args.artifacts)
      ? args.artifacts : null;
    const staticCheck = ctx.bb.get('$.staticCheck');
    const perfCheck = ctx.bb.get('$.perfCheck');
    const securityCheck = ctx.bb.get('$.securityCheck');
    const review = ctx.bb.get('$.review');
    const artifacts = custom || {
      explore: ctx.bb.get('$.explore'),
      staticCheck,
      perfCheck,
      securityCheck,
      plan: ctx.bb.get('$.plan'),
      advise: ctx.bb.get('$.advise'),
      review,
      revised: ctx.bb.get('$.revised'),
    };
    const hashes = {};
    for (const [k, v] of Object.entries(artifacts)) if (v != null) hashes[k] = hash(v);
    const lint = ctx.bb.get('$._lint') || { score: null };
    const data = {
      runId,
      timestamp: new Date().toISOString(),
      reproducible: true,
      command: `node src/cli.js run ${ctx.chain.id} --goal "${goal}"`,
      artifacts,
      hashes,
      gates: {
        functional: review && typeof review.score === 'number' ? review.score : null,
        static: staticCheck && typeof staticCheck.score === 'number' ? staticCheck.score : null,
        perf: perfCheck && typeof perfCheck.score === 'number' ? perfCheck.score : null,
        security: securityCheck && typeof securityCheck.score === 'number' ? securityCheck.score : null,
        regression: Array.isArray(ctx.chain.regressionTests) && ctx.chain.regressionTests.length > 0 ? 1 : (lint.score != null ? lint.score : null),
      },
      trace: { steps: ctx.tracer ? ctx.tracer.records.length : 0 },
    };
    if (ctx.tracer && ctx.tracer.info) ctx.tracer.info('evidence.done', `证据包已归档：${Object.keys(hashes).length} 项产物 / runId ${runId}`, { node: 'evidence' });
    return { data, issues: [], signals: ['evidence.done'] };
  },
  deletionGuard: (args, ctx) => {
    const PERSONAL = new Set(['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos', 'appdata', 'users']);
    const normPath = (s) => String(s || '').split('\\').join('/').replace(new RegExp('/+$'), '');
    const segHas = (p, set) => normPath(p).split('/').some((seg) => set.has(seg.toLowerCase()));
    const kwHit = (p, kws) => kws.some((k) => normPath(p).toLowerCase().includes(k.toLowerCase()));
    const DB_KW = ['db', 'database', 'mysql', 'postgres', 'sqlite', '.sql', 'table', 'schema', 'migration', 'queue', 'kafka', 'redis', 'eventstream'];
    const SOT_KW = ['.workbuddy', 'chains/', 'governance', '.git', 'source-of-truth'];
    const PERSIST_KW = ['user', 'permission', 'audit', 'billing', 'member', 'identity', 'record'];
    const recursiveLike = (p) => {
      const s = String(p).toLowerCase();
      return s.includes('*') || s.includes('-rf') || s.includes('-r ') || s.trim().endsWith('-r') || s.includes('--recursive') || s.includes('rm ');
    };
    const DERIVED_EXT = ['.cache', '.tmp', '.temp', '.log', '.lock', '.part'];

    const normalizeTargets = () => {
      let raw = args && (args.targets || args.target || (args.path ? { path: args.path } : null));
      if (!raw) return [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.map((t) => {
        const o = (typeof t === 'string') ? { path: t } : (t || {});
        return { path: String(o.path || ''), kind: o.kind || null, environment: (o.environment || (args && args.environment) || 'local'), note: o.note || '' };
      });
    };

    const VAGUE = new RegExp('^(ok|好的|继续|可以|同意|sounds good|proceed|go ahead|yes|确认|做吧|执行)$', 'i');
    const isScoped = (t) => {
      const uc = (args && args.userConfirmation) ? String(args.userConfirmation) : '';
      if (!uc || VAGUE.test(uc.trim())) return false;
      const p = normPath(t.path).toLowerCase();
      const e = String(t.environment || 'local').toLowerCase();
      return uc.toLowerCase().includes(p) && (uc.toLowerCase().includes(e) || /不可逆|irreversible|destruction|destructive/.test(uc.toLowerCase()));
    };

    const classify = (t) => {
      const p = t.path;
      if (t.kind) {
        const k = String(t.kind).toLowerCase();
        if (['db-table', 'db-row', 'queue', 'record', 'user', 'permission', 'audit', 'billing', 'member', 'identity', 'live-state'].includes(k)) return 'persistent-state';
        if (k === 'cache') return 'derived-state';
        if (k === 'config') return 'contract-carrying';
        if (k === 'source') return 'code-retirement';
        if (k === 'file' || k === 'dir') {
          if (segHas(p, PERSONAL) || kwHit(p, SOT_KW)) return 'persistent-state';
          if (recursiveLike(p)) return 'persistent-state';
          return 'code-retirement';
        }
      }
      if (kwHit(p, DB_KW) || kwHit(p, PERSIST_KW) || kwHit(p, SOT_KW)) return 'persistent-state';
      if (segHas(p, PERSONAL)) return 'persistent-state';
      if (recursiveLike(p)) return 'persistent-state';
      if (DERIVED_EXT.some((e) => p.toLowerCase().endsWith(e)) || p.includes('node_modules') || p.includes('__pycache__') || p.includes('/dist/') || p.includes('/out/')) return 'derived-state';
      const SRC_EXT = ['.js', '.ts', '.py', '.java', '.go', '.md', '.json', '.yaml', '.yml'];
      if (SRC_EXT.some((e) => p.toLowerCase().endsWith(e)) && !kwHit(p, SOT_KW)) return 'code-retirement';
      return 'persistent-state';
    };

    const route = (t, cls) => {
      const env = String(t.environment || 'local').toLowerCase();
      if (env === 'prod') return 'confirmation-first';
      if (cls === 'persistent-state') return 'confirmation-first';
      if (cls === 'derived-state') return 'delete-first';
      if (cls === 'contract-carrying') return 'compat-exception';
      if (cls === 'code-retirement') return 'delete-first';
      return 'confirmation-first';
    };

    const targets = normalizeTargets();
    const classifications = [];
    const guardDecisions = [];
    const dataDestructionGuards = [];
    const blocked = [];
    const allowed = [];
    const issues = [];

    for (const t of targets) {
      const cls = classify(t);
      let routed = route(t, cls);
      const scoped = isScoped(t);
      const decision = { path: t.path, environment: t.environment || 'local', class: cls, route: routed, scopedConfirmation: scoped, status: 'pending' };
      if (cls === 'persistent-state' && !scoped) {
        decision.status = 'blocked';
        dataDestructionGuards.push({
          targetClass: cls, exactTargets: t.path, environment: t.environment || 'local',
          whyIrreversible: 'persistent-state / 不可逆 source-of-truth：真实用户数据或治理资产，删除不可重建',
          backupRollbackNote: '删除前须备份(cp -r / 导出)，确认可回滚后再执行',
          allowedReadOnlyNextSteps: '仅可列目录/读内容/打快照，不得 emit 任何破坏性命令',
          blockedDestructiveSteps: 'DROP / TRUNCATE / rm -rf / 递归删除 / 覆盖写 / 清空队列',
          confirmationRequired: 'yes', status: 'awaiting-scoped-confirmation',
        });
        blocked.push(decision);
        issues.push({ severity: 'critical', where: 'deletionGuard.' + (t.path || '?'), msg: 'persistent-state 删除被硬停(L-GOV-002/L-GOV-032)：目标 ' + t.path + ' 须用户显式 scoped 授权，空泛同意无效' });
      } else if (cls === 'contract-carrying' && routed === 'compat-exception' && !scoped) {
        decision.route = 'confirmation-first';
        decision.status = 'blocked';
        decision.note = 'compat-exception 缺活跃外部依赖证据，降级 confirmation-first 并阻断';
        blocked.push(decision);
        issues.push({ severity: 'high', where: 'deletionGuard.' + (t.path || '?'), msg: 'contract-carrying 目标 ' + t.path + ' 无活跃依赖证据，已降级 confirmation-first 并阻断' });
      } else if (routed === 'confirmation-first' && !scoped) {
        decision.status = 'blocked';
        blocked.push(decision);
        issues.push({ severity: 'high', where: 'deletionGuard.' + (t.path || '?'), msg: '路由 confirmation-first 的目标 ' + t.path + ' 缺少显式 scoped 授权，已阻断' });
      } else {
        decision.status = 'allowed';
        decision.verificationPlan = { mainPath: '新 canonical owner 仍满足预期行为', lingeringReference: '退役职责不再活跃、主路径不再引用', negative: '退役触发器/路径确实停止工作', boundary: 'host/API/schema/persistence 边界未被意外破坏' };
        allowed.push(decision);
      }
      classifications.push({ path: t.path, class: cls });
      guardDecisions.push(decision);
    }

    const data = {
      classifications, guardDecisions, dataDestructionGuards,
      summary: { total: targets.length, blocked: blocked.length, allowed: allowed.length, persistentStateBlocked: blocked.filter((b) => b.class === 'persistent-state').length },
    };
    const signals = blocked.length ? ['deletionGuard.blocked'] : ['deletionGuard.allowed'];
    if (ctx && ctx.tracer && ctx.tracer.info) ctx.tracer.info(signals[0], '删除护栏：阻断 ' + blocked.length + ' / 放行 ' + allowed.length + '（persistent-state 硬停 ' + data.summary.persistentStateBlocked + '）', { node: 'deletionGuard' });
    return { data, issues, signals };
  },
  verificationGate: (args, ctx) => {
    const REQUIRED = ['action', 'check', 'result'];
    const DONE_RE = new RegExp('完成|已修复|修复|通过|可发布|可提交|可合并|可交付|done|fixed|pass|ready|release|merge', 'i');
    const normalize = () => {
      let raw = args && (args.claims || (args.claim ? [args.claim] : null));
      if (!raw) return [];
      return (Array.isArray(raw) ? raw : [raw]).map((c) => (c && typeof c === 'object' ? c : {}));
    };
    const claims = normalize();
    if (claims.length === 0) {
      return { data: { receipts: [], aggregated: { grade: 'C', ok: false }, note: 'no-claim' }, issues: [{ severity: 'high', where: 'verificationGate', msg: 'verificationGate 未收到任何 claim：声称完成前必须附带证据，不得空声称' }], signals: ['verification.fail'] };
    }
    const GRADE_RANK = { A: 0, B: 1, C: 2 };
    const receipts = [];
    let anyFail = false;
    let worst = 'A';
    for (const c of claims) {
      const missing = REQUIRED.filter((k) => c[k] === undefined || c[k] === null || String(c[k]).trim() === '');
      let confidence = String(c.confidence || 'C').toUpperCase();
      if (!['A', 'B', 'C'].includes(confidence)) confidence = 'C';
      const claimsDone = DONE_RE.test(String(c.action || ''));
      let ok = true;
      let note = '';
      if (missing.length) { ok = false; note = '缺少必填证据槽位: ' + missing.join(', '); }
      else if (confidence === 'C' && claimsDone) { ok = false; note = '置信度 C(仅部分证据)不得声称完成；降为 needs-verification'; }
      else if (!claimsDone && confidence === 'C') { ok = true; note = '部分证据，标记 needs-verification(未声称完成)'; }
      if (c.destructivePermission) {
        if (confidence !== 'A') { anyFail = true; note += '；破坏性操作须 confidence=A 且显式授权'; }
        else note += '；破坏性操作已带 A 级证据，仍需 deletionGuard scoped 授权';
      }
      if (!ok) anyFail = true;
      if (GRADE_RANK[confidence] > GRADE_RANK[worst]) worst = confidence;
      receipts.push({ action: c.action || '(未命名 claim)', grade: confidence, ok, missingSlots: missing, note: note.trim(), evidence: { check: c.check, result: c.result, coveredScope: c.coveredScope, uncoveredScope: c.uncoveredScope, residualRisk: c.residualRisk } });
    }
    const aggregated = { grade: worst, ok: !anyFail };
    const issues = [];
    if (anyFail) for (const r of receipts) if (!r.ok) issues.push({ severity: 'high', where: 'verificationGate.' + (r.action || ''), msg: '完成证据不足：' + r.note });
    const signals = anyFail ? ['verification.fail'] : ['verification.pass'];
    if (ctx && ctx.tracer && ctx.tracer.info) ctx.tracer.info(signals[0], '完成前证据契约：聚合置信度 ' + worst + '，' + (anyFail ? '未通过' : '通过') + '（' + receipts.length + ' 项 claim）', { node: 'verificationGate' });
    return { data: { receipts, aggregated }, issues, signals };
  },
  boundaryDecide: (args, ctx) => {
    const goal = String(
      (args && (args.goal || args.raw)) ||
      (ctx.bb.get('$.intake') && ctx.bb.get('$.intake').goal) ||
      ''
    );
    // 轻量分类（类型自己定、怎么顺手怎么分；不好用就改）
    let type = 'unspecified';
    if (/新增链|新链|新建链|子链/.test(goal)) type = 'chain-add';
    else if (/拆分|split|合并|merge/.test(goal)) type = 'chain-split-merge';
    else if (/functions\.js|内置|builtin|fn /.test(goal)) type = 'builtin-fn-edit';
    else if (/redlines|principle|version|元数据|治理字段/.test(goal)) type = 'meta-edit';
    else if (/资产|asset|灵感|materials|index\.json|知识库/.test(goal)) type = 'asset-land';
    else if (/白名单|gitignore|whitelist/.test(goal)) type = 'whitelist-edit';
    else if (/节点|node|prompt|expect|when|gate/.test(goal)) type = 'node-edit';
    // 破坏性措辞检测（升级人，不 AI 自批）
    const destructive = /删(除)?|清空|迁移|推倒|重写|从零|rm |drop |reset --hard|覆盖现有|废弃现有/.test(goal);
    const decision = destructive ? 'escalate' : 'approved';
    const rationale = destructive
      ? '含不可逆/破坏性措辞，依删除铁律与 RT-CHAIN-GO-3 仍交人裁定'
      : '可逆/本地/非破坏性边界，AI 自决（标准：好用不好用，后续不好用即迭代）';
    const boundary = {
      type,
      destructive,
      decision,
      rationale,
      openQuestions: destructive ? ['破坏性动作需人显式授权后方可继续'] : [],
      decidedAt: new Date().toISOString(),
    };
    ctx.bb.set('$.boundary', boundary);
    return {
      data: boundary,
      issues: [],
      signals: [destructive ? 'decision.escalate' : 'decision.approved'],
    };
  },
  applyIdentity: (args, ctx) => {
    const id = args.identity || {};
    const baseDir = args.baseDir
      || path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy');
    const dir = path.resolve(baseDir);
    const agent = id.agent || {};
    const user = id.user || {};
    const written = [];
    const issues = [];

    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { data: { ok: false, dir }, issues: [{ severity: 'high', where: 'baseDir', msg: '无法创建/访问目标目录：' + e.message }], signals: ['identity.failed'] };
    }

    const identityMd =
`---
summary: "Agent identity record"
read_when:
  - Bootstrapping a workspace manually
---

# IDENTITY.md - Who Am I?

- **Name:** ${agent.name || '（未设定）'}
- **Creature:** ${agent.nature || 'AI 助手'}
- **Vibe:** ${agent.vibe || '（未设定）'}
- **Emoji:** ${agent.emoji || '🤖'}

---
_由 identity-bootstrap 链写入。_
`;

    const projects = Array.isArray(id.projects) && id.projects.length
      ? id.projects.map((p) => '- ' + (typeof p === 'string' ? p : (p.name || JSON.stringify(p)))).join('\n')
      : (id.projects ? '- ' + id.projects : '_（暂无）_');

    const userMd =
`---
summary: "User profile record"
read_when:
  - Bootstrapping a workspace manually
---

# USER.md - About Your Human

- **Name:** ${user.name || '（未设定）'}
- **What to call them:** ${user.alias || user.name || '（未设定）'}
- **Pronouns:** ${user.pronouns || '_（可选）_'}
- **City:** ${user.city || '_（未设定）_'}
- **Notes:** ${user.notes || '_（暂无）_'}

## Context

${user.context || '（暂无）'}

## Projects

${projects}

---
_由 identity-bootstrap 链写入。_
`;

    const soulExtra = (id.soul || '').trim();
    const preferences = Array.isArray(id.preferences) && id.preferences.length
      ? id.preferences.map((p) => '- ' + p).join('\n')
      : (typeof id.preferences === 'string' && id.preferences ? id.preferences : '_（用户尚未补充偏好）_');

    const soulMd =
`---
title: "SOUL.md"
summary: "Workspace soul record (managed by identity-bootstrap)"
read_when:
  - Bootstrapping a workspace manually
---

# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.**
**Have opinions.**
**Be resourceful before asking.**
**Earn trust through competence.**
**Remember you're a guest.**

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.

## Vibe

Be the assistant you'd actually want to talk to.

## Standing Soul (set by user)

${soulExtra || '_（用户尚未补充常驻偏好）_'}

## Standing Preferences

${preferences}

## Continuity

These files _are_ your memory. Read them. Update them.

---
_This file is yours to evolve._
`;

    try {
      fs.writeFileSync(path.join(dir, 'IDENTITY.md'), identityMd, 'utf8'); written.push('IDENTITY.md');
      fs.writeFileSync(path.join(dir, 'USER.md'), userMd, 'utf8'); written.push('USER.md');
      fs.writeFileSync(path.join(dir, 'SOUL.md'), soulMd, 'utf8'); written.push('SOUL.md');
    } catch (e) {
      issues.push({ severity: 'high', where: 'applyIdentity', msg: '写入身份文件失败：' + e.message });
      return { data: { ok: false, written, dir }, issues, signals: ['identity.failed'] };
    }
    if (ctx.tracer && ctx.tracer.info) ctx.tracer.info('identity.applied', `已写入 ${written.join(', ')} 至 ${dir}`, { node: 'applyIdentity' });
    return { data: { ok: true, written, dir, baseDir: dir }, signals: ['identity.applied'] };
  },
  removeBootstrap: (args, ctx) => {
    const baseDir = args.baseDir
      || path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy');
    const dir = path.resolve(baseDir);
    const target = path.join(dir, 'BOOTSTRAP.md');
    const issues = [];
    if (!fs.existsSync(target)) {
      issues.push({ severity: 'low', where: 'removeBootstrap', msg: 'BOOTSTRAP.md 已不存在（可能已删除）' });
      return { data: { removed: false, target, alreadyGone: true }, issues, signals: ['bootstrap.removed'] };
    }
    try {
      fs.unlinkSync(target);
    } catch (e) {
      issues.push({ severity: 'high', where: 'removeBootstrap', msg: '删除 BOOTSTRAP.md 失败：' + e.message });
      return { data: { removed: false, target }, issues, signals: ['bootstrap.failed'] };
    }
    if (ctx.tracer && ctx.tracer.info) ctx.tracer.info('bootstrap.removed', `已删除 ${target}`, { node: 'removeBootstrap' });
    return { data: { removed: true, target }, signals: ['bootstrap.removed'] };
  },
  chainExtend: (args, ctx) => {
    const issues = [];
    const s = (args && args.spec) ? args.spec : (args || {});
    const target = s.target || s.chain;
    const rewire = s.rewire;
    const mock = s.mock;
    const bump = (s.bump === undefined ? 'minor' : s.bump);
    const dryRun = !!s.dryRun;
    const force = !!s.force;
    const reinsert = !!s.reinsert;
    const autoCodeNodes = !!s.autoCodeNodes;

    const fail = (extra) => {
      const data = Object.assign({ ok: false, file: null, issues }, extra || {});
      return { data, signals: ['chainExtend.failed'], issues };
    };

    if (!target) return fail({ reason: 'missing-target' });

    // 收集要插入的节点：spec.node（单节点，向后兼容）+ spec.nodes（数组，批量）
    const toInsert = [];
    if (s.node && s.node.id) toInsert.push(s.node);
    if (Array.isArray(s.nodes)) { for (const n of s.nodes) { if (n && n.id) toInsert.push(n); } }
    if (toInsert.length === 0 && !autoCodeNodes) {
      issues.push({ severity: 'high', where: 'chainExtend', msg: 'spec.node / spec.nodes 均为空，且无 autoCodeNodes，无可插入节点' });
      return fail({ reason: 'missing-node' });
    }

    const chainsDir = path.resolve(__dirname, '../../chains');
    const rawTarget = String(target);
    const candidates = [];
    if (rawTarget.endsWith('.json')) {
      candidates.push(rawTarget, path.join(chainsDir, rawTarget), path.resolve(process.cwd(), rawTarget));
    } else {
      candidates.push(path.join(chainsDir, `${rawTarget}.json`), path.resolve(process.cwd(), rawTarget), path.resolve(process.cwd(), `${rawTarget}.json`));
    }
    const fp = candidates.find((c) => fs.existsSync(c)) || candidates[0];
    let chain;
    try { chain = JSON.parse(fs.readFileSync(fp, 'utf8')); }
    catch (e) { issues.push({ severity: 'high', where: fp, msg: `链文件读取/解析失败：${e.message}` }); return fail({ file: fp }); }

    const nodes = chain.nodes || (chain.chain && chain.chain.nodes);
    if (!Array.isArray(nodes)) { issues.push({ severity: 'high', where: fp, msg: '链缺少 nodes 数组' }); return fail({ file: fp }); }

    // 代码锚点自动注入（作业1c）：autoCodeNodes 或 目标链 intent/title 命中代码关键词
    const anchorTplPath = path.resolve(__dirname, '../../chains/governance/code-anchor-nodes.json');
    let codeAnchorNodes = [];
    let codeAnchorReason = null;
    const wantCode = autoCodeNodes || (function () {
      try {
        const tpl = JSON.parse(fs.readFileSync(anchorTplPath, 'utf8'));
        const kws = (tpl.detectionKeywords || []).map((k) => String(k).toLowerCase());
        const hay = [chain.intent, chain.title, chain.id].filter(Boolean).join(' ').toLowerCase();
        const hit = kws.filter((k) => hay.indexOf(k) >= 0);
        if (hit.length) { codeAnchorReason = 'intent-keywords:' + hit.join(','); return true; }
      } catch (e) { issues.push({ severity: 'medium', where: 'code-anchor', msg: `读取代码锚点模板失败：${e.message}` }); }
      return false;
    })();
    if (wantCode) {
      try {
        const tpl = JSON.parse(fs.readFileSync(anchorTplPath, 'utf8'));
        codeAnchorNodes = Array.isArray(tpl.nodes) ? tpl.nodes.slice() : [];
      } catch (e) { issues.push({ severity: 'medium', where: 'code-anchor', msg: `读取代码锚点模板失败：${e.message}` }); }
    }

    // 合并插入集合，并为代码锚点接驳触发信号（首锚点接驳目标链末非-halt 节点的 .done/.end 信号）
    const insertList = toInsert.slice();
    if (codeAnchorNodes.length) {
      let anchorOn = 'chain.start';
      for (let i = nodes.length - 1; i >= 0; i--) {
        const ln = nodes[i];
        if (ln && ln.halt) continue;
        const declared = Array.isArray(ln.declares) ? ln.declares : [];
        const sig = declared.find((d) => /(\.done|\.end)$/.test(d)) || declared[0];
        if (sig) { anchorOn = 'signal.' + sig; break; }
      }
      for (const n of codeAnchorNodes) {
        if (n.id === 'codeOptimize') n.trigger = [{ on: anchorOn }];
        else if (n.id === 'bugFix') n.trigger = [{ on: 'signal.code.optimize.done' }];
        else if (n.id === 'docGen') n.trigger = [{ on: 'signal.code.debug.done' }];
      }
      insertList.push(...codeAnchorNodes);
    }

    // 幂等插入：已存在同 id 且非 reinsert 则跳过（不静默覆盖）
    const working = nodes.slice();
    const insertedIds = [];
    const skippedIds = [];
    for (const ns of insertList) {
      if (!ns || !ns.id) continue;
      const ex = working.find((n) => n.id === ns.id);
      if (ex && !reinsert) { skippedIds.push(ns.id); continue; }
      if (ex && reinsert) { const i = working.findIndex((n) => n.id === ns.id); working[i] = ns; }
      else { working.push(ns); }
      insertedIds.push(ns.id);
    }
    if (insertList.length && insertedIds.length === 0 && skippedIds.length) {
      issues.push({ severity: 'medium', where: 'chainExtend', msg: `节点 ${skippedIds.join(',')} 已存在且 reinsert=false，已跳过（避免静默覆盖）` });
      return fail({ reason: 'exists', skipped: true, file: fp, skippedIds });
    }

    const rewired = [];
    if (rewire) {
      const trigArr = (n) => Array.isArray(n.trigger) ? n.trigger : (Array.isArray(n.triggers) ? n.triggers : (n.trigger ? [n.trigger] : []));
      if (rewire.findTriggerOn && rewire.setTriggerOn) {
        for (const n of working) {
          if (insertedIds.indexOf(n.id) >= 0) continue; // 跳过新插入节点自身，避免把它的 trigger 也改写为自身信号导致自触发
          for (const t of trigArr(n)) {
            if (t && t.on === rewire.findTriggerOn) {
              const from = t.on; t.on = rewire.setTriggerOn; rewired.push({ nodeId: n.id, from, to: rewire.setTriggerOn });
            }
          }
        }
      } else if (rewire.nodeId && rewire.signal) {
        const n = working.find((x) => x.id === rewire.nodeId);
        if (n) {
          const ta = trigArr(n);
          const from = (ta[0] && ta[0].on) || null;
          if (ta[0]) ta[0].on = rewire.signal;
          else n.trigger = { on: rewire.signal };
          rewired.push({ nodeId: n.id, from, to: rewire.signal });
        }
      }
    }

    const versionBefore = chain.version || (chain.metadata && chain.metadata.version);
    let versionAfter = versionBefore;
    if (bump && versionBefore && /^\d+\.\d+\.\d+$/.test(String(versionBefore))) {
      let [maj, min, pat] = String(versionBefore).split('.').map(Number);
      if (bump === 'major') versionAfter = `${maj + 1}.0.0`;
      else if (bump === 'minor') versionAfter = `${maj}.${min + 1}.0`;
      else if (bump === 'patch') versionAfter = `${maj}.${min}.${pat + 1}`;
    }

    // 内联 lint 候选链（写盘前闸门）
    let lintRes = null;
    try {
      const lintMod = require('../governance/lint');
      const candidate = JSON.parse(JSON.stringify(chain));
      candidate.nodes = working;
      if (versionAfter) { if (candidate.metadata) candidate.metadata.version = versionAfter; else candidate.version = versionAfter; }
      lintRes = lintMod.lint(candidate);
    } catch (e) { issues.push({ severity: 'medium', where: 'lint', msg: `内联 lint 失败：${e.message}` }); }

    const lintErrors = (lintRes && lintRes.errors) || 0;
    const wouldWrite = !dryRun && (force || lintErrors === 0);

    // mock 分支追加（仅在真写时）
    const mockOut = { requested: !!mock, appended: false, skipped: false, path: null };
    if (mock && wouldWrite) {
      const mockPath = path.resolve(__dirname, '../adapters/mock.js');
      mockOut.path = mockPath;
      try {
        let mf = fs.readFileSync(mockPath, 'utf8');
        const caseToken = `case '${mock.caseName}':`;
        if (mf.indexOf(caseToken) >= 0) { mockOut.skipped = true; }
        else {
          const marker = mock.switchMarker || `case '${mock.role}':`;
          const mp = mf.indexOf(marker);
          if (mp < 0) { issues.push({ severity: 'medium', where: 'mock', msg: `未找到角色标记 ${marker}` }); }
          else {
            const def = mf.indexOf('default:', mp);
            if (def < 0) { issues.push({ severity: 'medium', where: 'mock', msg: '未找到 default: 锚点' }); }
            else {
              const sigs = Array.isArray(mock.signals) ? mock.signals : [`${mock.caseName}.done`];
              const block = `\n          case '${mock.caseName}':\n            return wrap(${JSON.stringify(mock.returns, null, 2)},\n              ${JSON.stringify(sigs)});\n`;
              mf = mf.slice(0, def) + block + mf.slice(def);
              fs.writeFileSync(mockPath, mf, 'utf8');
              mockOut.appended = true;
            }
          }
        }
      } catch (e) { issues.push({ severity: 'medium', where: 'mock', msg: `mock 追加失败：${e.message}` }); }
    }

    // 写回链文件（仅当闸门通过）
    if (wouldWrite) {
      try {
        const out = JSON.parse(JSON.stringify(chain));
        out.nodes = working;
        if (versionAfter) { if (out.metadata) out.metadata.version = versionAfter; else out.version = versionAfter; }
        fs.writeFileSync(fp, JSON.stringify(out, null, 2) + '\n', 'utf8');
      } catch (e) { issues.push({ severity: 'high', where: fp, msg: `写回失败：${e.message}` }); return { data: { ok: false, file: fp, lint: lintRes, issues }, signals: ['chainExtend.failed'], issues }; }
    }

    const ok = wouldWrite && lintErrors === 0;
    return {
      data: {
        ok, dryRun, wrote: wouldWrite, file: fp,
        insertedNodeId: insertedIds[0] || null,
        insertedNodeIds: insertedIds,
        skippedNodeIds: skippedIds,
        codeAnchor: { wanted: wantCode, reason: codeAnchorReason, injected: codeAnchorNodes.map((n) => n.id) },
        beforeNodes: nodes.length, afterNodes: working.length,
        rewired, versionBefore, versionAfter,
        mock: mockOut,
        lint: lintRes ? { errors: lintRes.errors, orphans: lintRes.orphans, score: lintRes.score, gates: lintRes.gates } : null,
      },
      signals: ok ? ['chainExtend.done'] : ['chainExtend.failed'],
      issues,
    };
  },
  governanceCrossCheck: (args, ctx) => {
    const chains = Array.isArray(args.chains) ? args.chains : [];
    const skills = Array.isArray(args.skills) ? args.skills : [];
    const oversizeAt = Number(args.oversizeNodeCount || 18);

    const chainById = new Map(chains.map((c) => [c.id, c]));
    const findings = [];
    const push = (severity, type, target, msg, suggestion) =>
      findings.push({ severity, type, target, msg, suggestion });

    // 1) skill 与链的版本漂移 / 引用失效
    //    版本漂移只比对「主链」（frontmatter 里出现的那条），避免正文顺带提及导致误报
    const versionDrift = [];
    const brokenRefs = [];
    for (const s of skills) {
      const retired = new Set(s.retiredRefs || []);
      const primary = s.primaryChain && chainById.get(s.primaryChain);
      if (primary && s.version && primary.version && s.version !== primary.version) {
        versionDrift.push({ skill: s.id, skillVersion: s.version, chain: primary.id, chainVersion: primary.version });
      }
      for (const ref of s.chainRefs || []) {
        if (chainById.has(ref)) continue;
        if (retired.has(ref)) continue; // 正文已注明退役/已合并，属于历史说明，不算失效引用
        brokenRefs.push({ skill: s.id, chainRef: ref });
      }
    }
    for (const d of versionDrift) {
      push('medium', 'versionDrift', d.skill,
        `skill ${d.skill} 声明 v${d.skillVersion}，但其链 ${d.chain} 已到 v${d.chainVersion}`,
        `把 ${d.skill}/SKILL.md 的 version 同步到 ${d.chainVersion} 并补写变更点`);
    }
    for (const b of brokenRefs) {
      push('low', 'brokenChainRef', b.skill,
        `skill ${b.skill} 正文引用了不存在的链 ${b.chainRef}`,
        `确认该链是否已退役；若已退役请在 SKILL.md 标注或删除引用`);
    }

    // 2) 链没有对应 skill（入口盲区）
    //    基础设施链（tier:"infra"）属于运行时/连通性支撑，不要求自然语言入口，予以豁免。
    const referenced = new Set(skills.flatMap((s) => s.chainRefs || []));
    const exemptChains = chains.filter((c) => c.tier === 'infra').map((c) => c.id);
    const chainsWithoutSkill = chains
      .filter((c) => !referenced.has(c.id) && c.tier !== 'infra')
      .map((c) => c.id);
    for (const id of chainsWithoutSkill) {
      push('medium', 'chainWithoutSkill', id,
        `链 ${id} 没有任何 skill 指向它，用户无法用自然语言触发`,
        `为 ${id} 新增或挂载到已有 skill，作为自然语言入口`);
    }

    // 3) skill 没有对应链（悬空 skill）
    const skillsWithoutChain = skills.filter((s) => !(s.chainRefs || []).some((r) => chainById.has(r))).map((s) => s.id);
    for (const id of skillsWithoutChain) {
      push('low', 'skillWithoutChain', id, `skill ${id} 未引用任何现存链`, `确认其是否为纯知识型 skill；否则补充链引用`);
    }

    // 4) skill 元数据缺口
    const skillMetaIssues = skills
      .filter((s) => !s.version || !s.description)
      .map((s) => ({ skill: s.id, missing: [!s.version && 'version', !s.description && 'description/summary'].filter(Boolean) }));
    for (const m of skillMetaIssues) {
      push('low', 'skillMeta', m.skill, `skill ${m.skill} frontmatter 缺 ${m.missing.join(' / ')}`, `补齐 frontmatter 以便治理链追踪版本漂移`);
    }

    // 5) 链治理门缺口
    const missingAcceptance = chains.filter((c) => !c.hasAcceptance).map((c) => c.id);
    const missingBudget = chains.filter((c) => !c.hasBudget).map((c) => c.id);
    const missingPrinciple = chains.filter((c) => !c.hasPrinciple).map((c) => c.id);
    for (const id of missingAcceptance) push('high', 'missingAcceptance', id, `链 ${id} 缺 acceptance 验收门`, `补 acceptance 数组，否则裁决层无判据`);
    for (const id of missingBudget) push('high', 'missingBudget', id, `链 ${id} 缺 budget 熔断`, `补 budget（maxSteps/maxLlmCalls/maxNodeRuns）`);
    for (const id of missingPrinciple) push('medium', 'missingPrinciple', id, `链 ${id} 缺 principle 战略层约束`, `补 principle 数组`);

    // 5b) 缺机械治理闸门（redlines / assert / evidence 三选一）
    //     对齐 chains/governance/iron-laws.json 的 chainGovernanceBaseline.requiredGates。
    //     每链须至少有一道机械闸门 + 引用 SSOT；否则「每条铁链都有治理机制」只是记忆而非可检机制。
    const missingGovernanceGate = chains.filter((c) => !c.hasGovernanceGate).map((c) => c.id);
    for (const id of missingGovernanceGate) {
      push('high', 'missingGovernanceGate', id,
        `链 ${id} 缺机械治理闸门（redlines / assert / evidence 三选一皆无），违反 iron-laws.json 的 requiredGates`,
        `补一道 redlines 闸门节点（in 里引用 chains/governance/iron-laws.json 为 SSOT），使治理成为机器可检查项`);
    }

    // 6) 规模膨胀
    const oversized = chains.filter((c) => c.nodeCount >= oversizeAt)
      .map((c) => ({ id: c.id, nodeCount: c.nodeCount, llmCount: c.llmCount }));
    for (const o of oversized) {
      push('medium', 'oversizedChain', o.id,
        `链 ${o.id} 已有 ${o.nodeCount} 个节点（llm ${o.llmCount} 个），超过 ${oversizeAt} 的建议上限`,
        `把独立业务维度拆成子链，主链只做编排`);
    }

    // 7) 意图重合（基于 intent/title 关键词的确定性重合度）
    const tokenize = (c) => new Set(String(`${c.title || ''} ${c.intent || ''}`)
      .toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ').split(' ')
      .filter((w) => w.length >= 2));
    const overlapPairs = [];
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = tokenize(chains[i]); const b = tokenize(chains[j]);
        if (!a.size || !b.size) continue;
        let inter = 0; for (const t of a) if (b.has(t)) inter++;
        const jaccard = inter / (a.size + b.size - inter);
        if (jaccard >= 0.3) overlapPairs.push({ a: chains[i].id, b: chains[j].id, jaccard: Number(jaccard.toFixed(3)) });
      }
    }
    overlapPairs.sort((x, y) => y.jaccard - x.jaccard);
    for (const p of overlapPairs) {
      push('medium', 'intentOverlap', `${p.a} + ${p.b}`,
        `链 ${p.a} 与 ${p.b} 意图词重合度 ${p.jaccard}`,
        `人工确认是否合并；若职责不同请拉开 intent 措辞`);
    }

    // 8) 影子回放回归建议（非阻断）：含副作用节点的链，建议补一次影子回放回归
    //    sideEffectFns 由 chainRegistryScan 在扫描时从节点 sideEffect:true 提取，无需完整 nodes。
    for (const c of chains) {
      const sideFx = Array.isArray(c.sideEffectFns) ? c.sideEffectFns : [];
      if (sideFx.length === 0) continue;
      const declared = c.shadowReplay || (c.metadata && c.metadata.shadowReplay);
      if (declared) continue; // 已声明有基线回归，跳过
      push('low', 'shadowReplayAdvised', c.id,
        `链 ${c.id} 含 ${sideFx.length} 个副作用节点（${sideFx.join(', ')}），建议合并前跑一次影子回放回归`,
        `node src/cli.js shadow ${c.id} --record --input <样例.json> 录制基线，改动后用 --baseline 回放比对一致性`);
    }

    // 9) 链责任人覆盖（对齐 L-GOV-025）：每条已注册链须在 chain-owners.json 登记唯一 owner
    let missingChainOwner = [];
    try {
      const ownersPath = path.join(__dirname, '..', '..', 'chains', 'governance', 'chain-owners.json');
      if (fs.existsSync(ownersPath)) {
        const owners = JSON.parse(fs.readFileSync(ownersPath, 'utf8'));
        const ownerMap = owners.owners || {};
        // 夹具链（_fixture 目录/文件 或 id 以 fixture. 开头）是测试脚手架，非生产链，豁免责任人登记
        const isFixture = (c) => (c.file && String(c.file).includes('_fixture')) || (c.id && String(c.id).startsWith('fixture.'));
        missingChainOwner = chains
          .filter((c) => !isFixture(c) && (!ownerMap[c.id] || !String(ownerMap[c.id].owner || '').trim()))
          .map((c) => c.id);
        // 漂移检测：注册表登记了但不在链清单（疑似废弃/重命名未同步）
        const registeredIds = new Set(chains.map((c) => c.id));
        const orphanOwnerEntries = Object.keys(ownerMap).filter((id) => !registeredIds.has(id));
        for (const id of orphanOwnerEntries) {
          push('low', 'orphanChainOwner', id,
            `chain-owners.json 登记了链 ${id} 但当前注册表无此链（疑似废弃/重命名未同步）`,
            `确认该链是否已合并/退役；若是请同步删除 chain-owners.json 对应条目`);
        }
      } else {
        push('high', 'missingOwnerRegistry', 'chain-owners.json',
          'chains/governance/chain-owners.json 不存在，无法校验 L-GOV-025 责任人覆盖',
          '新建 chain-owners.json 并为每条链登记 owner');
      }
    } catch (err) {
      push('high', 'ownerRegistryError', 'chain-owners.json', `责任人注册表读取失败：${err.message}`, '检查 chain-owners.json 合法性');
    }
    for (const id of missingChainOwner) {
      push('high', 'missingChainOwner', id,
        `链 ${id} 在 chain-owners.json 中无责任人（owner 空缺），违反 L-GOV-025`,
        `在 chain-owners.json 的 owners 下为 ${id} 登记 owner（默认 owner=用户技术lead，executor=小鲸/AI）`);
    }

    // 10) 总论符合性（对齐 chains/governance/ajtc-creed.md / L-GOV-000 引擎宪法）
    //     新链 / skill 的 frontmatter 须声明 creed 字段，标明其设计对齐哪条总论信念
    //     （from=从哪里来 / road=走什么路 / identity=政治认同），使「系统总论」成为可检机制而非口号。
    //     与第 9 段 L-GOV-025 责任人校验同属「frontmatter 治理声明」，二者交叉：
    //     一条合规的生产链须同时登记 owner 与 creed。
    const missingCreedChains = chains.filter((c) => !c.creed || !String(c.creed).trim()).map((c) => c.id);
    const missingCreedSkills = skills.filter((s) => !s.creed || !String(s.creed).trim()).map((s) => s.id);
    for (const id of missingCreedChains) {
      push('medium', 'missingCreed', id,
        `链 ${id} 的 frontmatter 未声明 creed 字段（未对齐 ajtc-creed.md 总论信念）`,
        `在 ${id} 链定义顶层补 "creed": "from|road|identity" 之一，标明对齐哪条总论信念`);
    }
    for (const id of missingCreedSkills) {
      push('medium', 'missingCreed', id,
        `skill ${id} 的 frontmatter 未声明 creed 字段（未对齐 ajtc-creed.md 总论信念）`,
        `在 ${id}/SKILL.md 补 creed 字段，标明对齐哪条总论信念`);
    }

    const bySeverity = { high: 0, medium: 0, low: 0 };
    for (const f of findings) if (bySeverity[f.severity] !== undefined) bySeverity[f.severity]++;

    const data = {
      chainTotal: chains.length,
      skillTotal: skills.length,
      totalNodes: chains.reduce((s, c) => s + (c.nodeCount || 0), 0),
      totalLlmNodes: chains.reduce((s, c) => s + (c.llmCount || 0), 0),
      versionDrift,
      brokenRefs,
      chainsWithoutSkill,
      exemptChains,
      skillsWithoutChain,
      skillMetaIssues,
      missingAcceptance,
      missingBudget,
      missingPrinciple,
      missingGovernanceGate,
      missingChainOwner,
      missingCreedChains,
      missingCreedSkills,
      oversized,
      overlapPairs,
      findings,
      bySeverity,
      healthScore: Number(Math.max(0, 1 - (bySeverity.high * 0.1 + bySeverity.medium * 0.03 + bySeverity.low * 0.01)).toFixed(3)),
    };
    if (ctx.tracer && ctx.tracer.info) {
      ctx.tracer.info('governanceCrossCheck.done',
        `交叉核对：${chains.length} 链 / ${skills.length} skill，发现 ${findings.length} 项（high ${bySeverity.high} / medium ${bySeverity.medium} / low ${bySeverity.low}）`,
        { node: 'governanceCrossCheck' });
    }
    return { data, signals: ['crosscheck.done'] };
  },
  chainRegistryScan: (args, ctx) => {
    const root = args.root || path.resolve(__dirname, '../../chains');
    const issues = [];
    const chains = [];
    // 递归扫描 chains/ 所有子目录（与 src/registry.js 的 load() 对齐：
    // 链以 chains/<域>/<id>.json 物理分布，非递归扫描会漏掉全部子目录链）。
    // 跳过 node_modules 与 _fixture* 夹具目录。
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        issues.push({ severity: 'medium', where: dir, msg: `目录读取失败：${e.message}` });
        return;
      }
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name.startsWith('_fixture')) continue;
          walk(fp);
        } else if (e.isFile() && e.name.endsWith('.json')) {
          const rel = path.relative(root, fp);
          try {
            const c = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (!Array.isArray(c.nodes)) {
              issues.push({ severity: 'info', where: rel, msg: '非链文件（缺少 nodes 数组），已跳过' });
              continue;
            }
            const nodes = c.nodes || [];
            const hasRedlines = nodes.some((n) => n.use === 'redlines');
            const hasAssert = nodes.some((n) => n.use === 'assert');
            const hasEvidence = nodes.some((n) => n.use === 'evidence');
            chains.push({
              file: rel,
              id: c.id,
              title: c.title,
              version: c.version,
              tier: c.tier,
              intent: c.intent,
              creed: c.creed || null,
              nodeCount: nodes.length,
              llmCount: nodes.filter((n) => n.kind === 'llm').length,
              hasBudget: !!c.budget,
              hasAcceptance: !!(c.acceptance && c.acceptance.length),
              hasPrinciple: !!(c.principle && c.principle.length),
              hasRedlines,
              hasAssert,
              hasEvidence,
              hasGovernanceGate: hasRedlines || hasAssert || hasEvidence,
              sideEffectFns: nodes.filter((n) => n.sideEffect === true && n.use).map((n) => n.use),
              shadowReplay: !!(c.shadowReplay || (c.metadata && c.metadata.shadowReplay)),
            });
          } catch (err) {
            issues.push({ severity: 'medium', where: rel, msg: `解析失败：${err.message}` });
          }
        }
      }
    };
    walk(root);
    if (ctx.tracer && ctx.tracer.info) ctx.tracer.info('chainRegistryScan.done', `扫描到 ${chains.length} 条链`, { node: 'chainRegistryScan' });
    return { data: { root, chains, issues }, signals: [] };
  },
  skillRegistryScan: (args, ctx) => {
    const root = args.root || path.resolve(process.env.HOME || process.env.USERPROFILE || '.', '.workbuddy/skills');
    const skills = [];
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('_')) continue;
        const md = path.join(root, d.name, 'SKILL.md');
        let title = d.name, version = '', description = '', creed = '', hasFrontmatter = false, agentCreated = false, body = '';
        try {
          const content = fs.readFileSync(md, 'utf8');
          const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fm) {
            hasFrontmatter = true;
            const head = fm[1];
            // 本项目 skill 约定：title/summary 为主，description/version 为可选；两套口径都认
            title = (head.match(/^title:\s*(.+)$/m) || [])[1] || (head.match(/^name:\s*(.+)$/m) || [])[1] || d.name;
            version = (head.match(/^version:\s*(.+)$/m) || [])[1] || '';
            creed = (head.match(/^creed:\s*(.+)$/m) || [])[1] || '';
            description = (head.match(/^description:\s*(.+)$/m) || [])[1]
              || (head.match(/^summary:\s*(.+)$/m) || [])[1] || '';
            agentCreated = /^agent_created:\s*true\s*$/m.test(head);
            body = content.slice(fm[0].length);
          } else {
            body = content;
          }
        } catch (e) { /* ignore missing SKILL.md */ }
        // 从正文里提取引用到的链 id（gen.xxx / sys.xxx / memory.xxx）
        // 排除文件名/扩展名之类的假阳性：xxx.json / xxx.md / 纯数字后缀
        const RE_REF = /(?<![\w.\-/\\])(?:gen|sys|memory)\.[a-zA-Z][a-zA-Z0-9_-]*/g;
        const BAD_TAIL = /\.(json|md|js|ts|yml|yaml|txt|assistant\d)$/i;
        const refCount = new Map();
        const retiredRefs = new Set();
        const collect = (text, weight) => {
          let m;
          RE_REF.lastIndex = 0;
          while ((m = RE_REF.exec(text)) !== null) {
            const ref = m[0];
            if (BAD_TAIL.test(ref)) continue;
            refCount.set(ref, (refCount.get(ref) || 0) + weight);
            // 上下文若出现「退役/合并/废弃/deprecated」，标记为历史引用
            const around = text.slice(Math.max(0, m.index - 60), m.index + ref.length + 60);
            if (/退役|已合并|合并而来|废弃|deprecated|不再使用/.test(around)) retiredRefs.add(ref);
          }
        };
        // frontmatter 中出现的链视为主链候选（权重高）
        collect(`${title} ${description}`, 100);
        collect(body, 1);
        const chainRefs = Array.from(refCount.keys());
        let primaryChain = '';
        let best = -1;
        for (const [k, v] of refCount) if (v > best) { best = v; primaryChain = k; }
        skills.push({
          id: d.name, title, version: String(version).trim(), description: String(description).trim(),
          creed: String(creed).trim(),
          hasFrontmatter, agentCreated, chainRefs, primaryChain,
          retiredRefs: Array.from(retiredRefs),
        });
      }
    } catch (e) {
      /* ignore */
    }
    if (ctx.tracer && ctx.tracer.info) ctx.tracer.info('skillRegistryScan.done', `扫描到 ${skills.length} 个 skill`, { node: 'skillRegistryScan' });
    return { data: { root, skills }, signals: [] };
  },
  memRoute: (args, ctx) => {
  const goal = (args && (args.goal || args.text)) ||
    (ctx && ctx.bb && ctx.bb.get('$.intake.goal')) || '';
  const g = String(goal).toLowerCase();

  let asset = 'chat';
  if (/skill|技能|步骤|sop|playbook| reusable/.test(g)) asset = 'skill';
  else if (/wiki|文档|需求|设计稿|知识页|spec|doc/.test(g)) asset = 'wiki';
  else if (/codegraph|代码图|调用关系|实体关系|代码导入|repo/.test(g)) asset = 'codegraph';

  let layer = null;
  if (asset === 'chat') {
    if (/persona|人格|画像|长期偏好/.test(g)) layer = 'L3';
    else if (/scenario|场景|情境|上下文/.test(g)) layer = 'L2';
    else if (/atomic|原子|事实|知识点/.test(g)) layer = 'L1';
    else layer = 'L0'; // 默认落对话
  }

  return {
    data: { asset, layer, goal: String(goal).slice(0, 500) },
    signals: ['mem.routed'],
    issues: [],
  };
},
  memStoreConversation: async (args, ctx) => {
  const conv =
    (args && (args.conversation || args.text || args.input)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!conv) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'medium', where: 'memStoreConversation', msg: '无对话内容可存' }], signals: ['mem.l0.failed'] };
  }
  const r = await memCoreHttp('POST', '/v3/conversation/add', {
    body: { content: typeof conv === 'string' ? conv : JSON.stringify(conv), source: 'ajtc-memory-store' },
  });
  if (!r.ok) {
    return { data: { ok: false, degraded: r.degraded, error: r.error }, issues: [{ severity: r.degraded ? 'low' : 'medium', where: 'memStoreConversation', msg: r.error }], signals: ['mem.l0.degraded'] };
  }
  return { data: { ok: true, layer: 'L0', ref: r.data }, signals: ['mem.l0.stored'] };
},
  memUpsertAtomic: async (args, ctx) => {
  const atoms =
    (args && args.atoms) ||
    (ctx && ctx.bb && ctx.bb.get('$.mem.l0Atoms')) || [];
  if (!Array.isArray(atoms) || !atoms.length) {
    return { data: { ok: false, reason: 'no-atoms' }, issues: [{ severity: 'low', where: 'memUpsertAtomic', msg: '无原子事实可写' }], signals: ['mem.l1.skipped'] };
  }
  const results = [];
  for (const a of atoms.slice(0, 50)) {
    const r = await memCoreHttp('POST', '/v3/atomic/add', {
      body: { type: a.type || 'fact', content: a.content, confidence: a.confidence || 0.8 },
    });
    results.push(r.ok ? { ok: true, ref: r.data } : { ok: false, degraded: r.degraded, error: r.error });
  }
  const okCount = results.filter((x) => x.ok).length;
  return {
    data: { ok: true, layer: 'L1', total: atoms.length, written: okCount, results },
    signals: okCount ? ['mem.l1.stored'] : ['mem.l1.degraded'],
    issues: okCount < atoms.length ? [{ severity: 'low', where: 'memUpsertAtomic', msg: `${atoms.length - okCount} 条原子写入失败/降级` }] : [],
  };
},
  memWikiImport: async (args, ctx) => {
  const doc = (args && (args.doc || args.markdown || args.content)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!doc) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'low', where: 'memWikiImport', msg: '无文档内容可导入' }], signals: ['mem.wiki.failed'] };
  }
  const r = await memCoreHttp('POST', '/v3/wiki/import', {
    body: { content: typeof doc === 'string' ? doc : JSON.stringify(doc), source: 'ajtc-memory-store' },
  });
  if (!r.ok) {
    return { data: { ok: false, degraded: r.degraded, error: r.error }, issues: [{ severity: r.degraded ? 'low' : 'medium', where: 'memWikiImport', msg: r.error }], signals: ['mem.wiki.degraded'] };
  }
  return { data: { ok: true, asset: 'wiki', ref: r.data }, signals: ['mem.wiki.imported'] };
},
  memSkillAdd: async (args, ctx) => {
  const slice = (args && (args.slice || args.content)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!slice) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'low', where: 'memSkillAdd', msg: '无 skill 切片可写' }], signals: ['mem.skill.failed'] };
  }
  const r = await memCoreHttp('POST', '/v3/skill/conversation/add', {
    body: { content: typeof slice === 'string' ? slice : JSON.stringify(slice), source: 'ajtc-memory-store' },
  });
  if (!r.ok) {
    return { data: { ok: false, degraded: r.degraded, error: r.error }, issues: [{ severity: r.degraded ? 'low' : 'medium', where: 'memSkillAdd', msg: r.error }], signals: ['mem.skill.degraded'] };
  }
  return { data: { ok: true, asset: 'skill', ref: r.data }, signals: ['mem.skill.added'] };
},
  memDistillPersona: async (args, ctx) => {
  const persona =
    (args && args.persona) ||
    (ctx && ctx.bb && ctx.bb.get('$.mem.l3Persona')) || null;
  if (!persona) {
    return { data: { ok: false, reason: 'no-persona' }, issues: [{ severity: 'low', where: 'memDistillPersona', msg: '无人格画像可写回' }], signals: ['mem.l3.skipped'] };
  }
  const r = await memCoreHttp('POST', '/v3/atomic/add', {
    body: { type: 'persona', content: JSON.stringify(persona), confidence: 0.85 },
  });
  if (!r.ok) {
    return { data: { ok: false, degraded: r.degraded, error: r.error }, issues: [{ severity: r.degraded ? 'low' : 'medium', where: 'memDistillPersona', msg: r.error }], signals: ['mem.l3.degraded'] };
  }
  return { data: { ok: true, layer: 'L3', ref: r.data }, signals: ['mem.l3.stored'] };
},
  memCodeGraphImport: async (args, ctx) => {
  const repo = (args && (args.repo || args.code || args.path)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!repo) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'low', where: 'memCodeGraphImport', msg: '无代码内容可导入' }], signals: ['mem.codegraph.failed'] };
  }
  const r = await memCoreHttp('POST', '/v3/codegraph/import', {
    body: { content: typeof repo === 'string' ? repo : JSON.stringify(repo), source: 'ajtc-memory-store' },
  });
  if (!r.ok) {
    return { data: { ok: false, degraded: r.degraded, error: r.error }, issues: [{ severity: r.degraded ? 'low' : 'medium', where: 'memCodeGraphImport', msg: r.error }], signals: ['mem.codegraph.degraded'] };
  }
  return { data: { ok: true, asset: 'codegraph', ref: r.data }, signals: ['mem.codegraph.imported'] };
},
};

Object.assign(builtins, require('./memory-fns'));


/**
 * SIDE_EFFECT_HINTS —— 疑似副作用 fn 的命名启发式集合（收紧版，避免误报）。
 * 仅保留强指示词；刻意去掉 write/create/update/delete/exec/insert 等易误匹配的泛化子串
 * （如 RewriteCheck、createChain 会被误伤）。真实副作用隔离以「链节点 sideEffect:true
 * 声明」为权威来源；本集合仅作「疑似未标注」的兜底告警，绝不据此擅自 noop。
 */
const SIDE_EFFECT_HINTS = new Set([
  'persist', 'Persist', 'save', 'Save', 'store', 'Store',
  'archive', 'Archive', 'publish', 'Publish', 'send', 'Send', 'refund', 'Refund',
  'sync', 'Sync', 'git', 'Git', 'fetch', 'Fetch', 'http', 'Http',
  'upload', 'Upload', 'download', 'Download', 'mutate', 'Mutate', 'push', 'Push',
]);

module.exports = { builtins, SIDE_EFFECT_HINTS };
