'use strict';
/**
 * kernel.js —— 触发链执行内核
 *
 * 核心模型：**事件 → 触发器 → 节点 → 信封(envelope) → 新事件**
 *
 *   1. 一切驱动力都是事件（event）。内核维护一个 FIFO 事件队列。
 *   2. 节点不主动被调用，而是「订阅」事件：trigger = [{on, from, when}]。
 *   3. 每个节点无论 LLM 还是函数，统一返回同一个 JSON 信封：
 *        { meta, data, signals, issues, next }
 *   4. 信封里的 signals 会被转成 signal.<name> 事件重新入队 —— 链就这样自己长出来。
 *   5. 所有循环受 budget + maxRuns 双重熔断，不会跑飞。
 *
 * 内置事件：
 *   chain.start / chain.end / node.start / node.done / node.fail /
 *   node.throttled / budget.low / budget.exceeded / signal.<name>
 */

const { Blackboard } = require('./blackboard');
const { Tracer } = require('./tracer');
const { Budget, estimateTokens } = require('./budget');
const { evaluate, test, truthy } = require('./expr');
const { validate, explain } = require('./validator');
const { repairData } = require('./coerce');
const { repair } = require('./jsonRepair');
const { builtins } = require('./functions');
const { SignalCache, stableHash } = require('./cache');
const { preludeFns } = require('./prelude-fns');

const ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['data'],
  properties: {
    meta: { type: 'object' },
    data: { type: ['object', 'array'] },
    signals: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          where: { type: 'string' },
          msg: { type: 'string' },
        },
      },
    },
    next: { type: 'object' },
  },
};

/* ----------------------------- 模板渲染 ----------------------------- */
function render(tpl, ctx) {
  if (tpl == null) return '';
  if (typeof tpl !== 'string') return String(tpl);
  return tpl.replace(/\{\{([\s\S]+?)\}\}/g, (_, expr) => {
    let v;
    try { v = evaluate(String(expr).trim(), ctx); }
    catch (e) { return `<<表达式错误: ${String(expr).trim()} — ${e.message}>>`; }
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
}

/* --------------------------- 输入绑定解析 ---------------------------
 * 规则刻意做得极简且可预测：
 *   "$....."  → 按黑板路径求值
 *   "=....."  → 按表达式求值（去掉等号）
 *   其它字符串 → 原样字面量
 * RAW_KEYS 里的键整棵子树都不求值（因为它们本身就是「待运行时求值的表达式」）。
 */
/**
 * 这些键的整棵子树不做求值，因为它们本身就装着「留到运行时才求值的表达式」。
 * 只收结构性键名。像 raw / template / data 这类通用词绝不能进来——
 * 它们极易和业务参数名撞车，撞上以后表现是「$.xxx 被当字面量传进节点」，
 * 而且不报错，只在下游产出里泄漏出一个字符串，极难排查。
 */
const RAW_KEYS = new Set(['conditions', 'cases']);

function resolveBindings(spec, ctx) {
  if (spec == null) return {};
  if (typeof spec === 'string') {
    if (spec.startsWith('=')) return evaluate(spec.slice(1), ctx);
    if (spec.startsWith('$')) return evaluate(spec, ctx);
    return spec;
  }
  if (Array.isArray(spec)) return spec.map((s) => resolveBindings(s, ctx));
  if (typeof spec === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(spec)) {
      if (RAW_KEYS.has(k)) { out[k] = JSON.parse(JSON.stringify(v)); continue; }
      if (typeof v === 'string' && (v.startsWith('$') || v.startsWith('='))) {
        const src = v.startsWith('=') ? v.slice(1) : v;
        try { out[k] = evaluate(src, ctx); }
        catch (e) { out[k] = undefined; if (ctx.__onBindError) ctx.__onBindError(k, src, e); }
      } else if (v && typeof v === 'object') {
        out[k] = resolveBindings(v, ctx);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return spec;
}

/* ------------------------------- 内核 ------------------------------- */

/* ==================================================================
 * V2 新增：缓存新鲜度显式化 + W3C Trace Context
 * 【更新来源】MCP Specification 2026-07-28（上一版 2025-11-25）
 *   - SEP-2549 CacheableResult：列表类结果必须携带 ttlMs + cacheScope 两个
 *     新鲜度字段，ttlMs 为新鲜期（毫秒），cacheScope 声明能否跨用户共享。
 *   - SEP-414：_meta 约定 OpenTelemetry trace context 传播键
 *     （traceparent / tracestate / baggage）。
 *   规范 changelog：https://modelcontextprotocol.io/specification/2026-07-28/changelog
 * 【落地依据】docs/ajtc-vs-mcp-a2a-leftjoin.md §3「可直接抄的三点」
 * 【兼容性】全部 additive：旧字段 node.cache.ttl 仍生效，旧方法 SignalCache.set
 *   保持原样不动（Vn 风格并存），不改动任何既有行为。
 * ================================================================== */

// 把节点声明解析成显式缓存策略 {ttlMs, scope, source}
// ttlMs：node.cache.ttlMs 优先，退回旧字段 node.cache.ttl，都没有则 0（不过期）
// scope：'run'（仅本 run 复用，最保守）| 'chain' | 'global'；缺省与非法值一律 'run'
function resolveCachePolicyV2(node, legacyTtl) {
  const c = node && typeof node.cache === 'object' && node.cache !== null ? node.cache : {};
  let ttlMs = 0;
  let source = 'none';
  if (Number.isFinite(c.ttlMs) && c.ttlMs > 0) {
    ttlMs = c.ttlMs; source = 'node.cache.ttlMs';
  } else if (Number.isFinite(legacyTtl) && legacyTtl > 0) {
    ttlMs = legacyTtl; source = 'node.cache.ttl(legacy)';
  }
  const allowed = ['run', 'chain', 'global'];
  const scope = allowed.indexOf(c.scope) >= 0 ? c.scope : 'run';
  return { ttlMs, scope, source };
}

// 生成 / 继承 W3C Trace Context：传入上游则沿用同一 trace-id（跨链贯通），
// 否则新开一条；span-id 永远重新生成（本 run 是新的一段）。
function buildTraceContextV2(upstream) {
  const crypto = require('crypto');
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  let traceId = hex(16); // 32 hex
  let flags = '01';      // sampled
  const up = upstream || {};
  if (typeof up.traceparent === 'string') {
    const m = up.traceparent.match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
    if (m) { traceId = m[2]; flags = m[4]; }
  }
  return {
    traceparent: `00-${traceId}-${hex(8)}-${flags}`,
    tracestate: typeof up.tracestate === 'string' ? up.tracestate : '',
    baggage: typeof up.baggage === 'string' ? up.baggage : '',
  };
}

class Kernel {
  constructor(opts = {}) {
    if (!opts.chain) throw new Error('Kernel 需要 chain');
    this.chain = opts.chain;
    this.opts = opts; // V2：保留构造参数，供 trace context 继承等能力读取
    this.adapter = opts.adapter;
    this.tracer = opts.tracer || new Tracer({ level: opts.logLevel || 'info', silent: opts.silent });
    this.bb = opts.blackboard || new Blackboard(opts.initial || {});
    this.budget = opts.budget instanceof Budget
      ? opts.budget
      : new Budget({ ...(this.chain.budget || {}), ...(opts.budget || {}) });
    this.fns = { ...builtins, ...(opts.fns || {}) };
    this.loadChain = opts.loadChain || (() => { throw new Error('未提供 loadChain，无法执行子链'); });
    this.depth = opts.depth || 0;
    this.maxDepth = opts.maxDepth ?? 4;

    // 信号级缓存：可注入共享实例实现跨 run 记忆化；默认每 run 新建；opts.cache===false 关闭
    if (opts.cache === false) {
      this.cache = null;
    } else if (opts.cache && typeof opts.cache.get === 'function' && typeof opts.cache.set === 'function') {
      this.cache = opts.cache;
    } else {
      this.cache = new SignalCache(opts.cacheOpts || {});
    }
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.coerceHits = 0;

    this.queue = [];
    this.runs = Object.create(null);
    this.envelopes = Object.create(null);
    this.halted = false;
    this.haltReason = null;

    this.nodes = new Map();
    for (const n of this.chain.nodes || []) {
      if (this.nodes.has(n.id)) throw new Error(`链 ${this.chain.id} 存在重复节点 id: ${n.id}`);
      this.nodes.set(n.id, n);
    }

    // V2 触发索引（性能优化，additive）：事件名 → 订阅节点列表，通配符 `*` 单列。
    // 原实现每个事件都全量遍历所有节点跑 matchTrigger（O(事件×节点)）；
    // 索引后只扫「订阅了该事件的节点 + 通配符节点」，matchTrigger 语义（on/from/when）完全不变。
    this._nodeSeq = new Map();
    this._triggerIdx = new Map();
    this._wildcardNodes = [];
    {
      let seq = 0;
      for (const n of this.nodes.values()) this._nodeSeq.set(n.id, seq++);
      for (const n of this.nodes.values()) {
        for (const tr of n.trigger || []) {
          if (!tr || typeof tr.on !== 'string') continue;
          if (tr.on === '*') { this._wildcardNodes.push(n); continue; }
          if (!this._triggerIdx.has(tr.on)) this._triggerIdx.set(tr.on, []);
          this._triggerIdx.get(tr.on).push(n);
        }
      }
    }
  }

  // 某事件的候选节点：订阅者 ∪ 通配符，去重（同一节点可同时命中具体事件与 *），按声明序排列
  _candidateNodes(eventName) {
    const all = [...new Set([...(this._triggerIdx.get(eventName) || []), ...this._wildcardNodes])];
    if (all.length > 1) all.sort((a, b) => this._nodeSeq.get(a.id) - this._nodeSeq.get(b.id));
    return all;
  }

  /* ----------------------------- 事件 ----------------------------- */
  emit(name, from, payload) {
    const ev = { name, from: from || 'kernel', payload: payload ?? null, at: Date.now() };
    this.queue.push(ev);
    this.tracer.debug('event.emit', `${name}  ← ${ev.from}`, { event: name, from: ev.from });
    return ev;
  }

  buildCtx(node, event, inputs) {
    return {
      $: this.bb.data,
      bb: this.bb.data,
      event: event || { name: '', from: '', payload: null },
      node: node ? { id: node.id, kind: node.kind, role: node.role, runs: this.runs[node.id] || 0 } : {},
      run: { steps: this.budget.used.steps, llmCalls: this.budget.used.llmCalls, elapsedMs: this.budget.elapsedMs, depth: this.depth },
      in: inputs || {},
      env: this.envelopes,
      chain: { id: this.chain.id, title: this.chain.title },
    };
  }

  matchTrigger(node, event) {
    for (const tr of node.trigger || []) {
      if (tr.on !== '*' && tr.on !== event.name) continue;
      if (tr.from && tr.from !== event.from) continue;
      if (tr.when) {
        const ctx = this.buildCtx(node, event, {});
        if (!test(tr.when, ctx, (e) => this.tracer.warn('trigger.expr', `${node.id} 触发条件求值失败: ${e.message}`, { node: node.id }))) continue;
      }
      return tr;
    }
    return null;
  }

  /* --------------------------- 信号级缓存 --------------------------- */
  // 是否可缓存：仅显式 opt-in（cache:true / cache:{...}）才缓存。
  // 默认不缓存——fn/gate 节点常直接读黑板而非仅 node.in，若只按声明入参做键会在
  // 「入参相同但黑板已变」时返回陈旧结果（静默正确性 bug）。改缓存策略须显式声明。
  isCacheable(node) {
    if (node.cache === false) return false;
    if (node.cache === true || (node.cache && typeof node.cache === 'object')) return true;
    return false;
  }

  // 缓存键：节点 id + 触发事件名 + 入参哈希；LLM 额外含渲染后 prompt 哈希（prompt 一改即失效）
  cacheKeyFor(node, event, inputs) {
    let key = `${node.id}::${event ? event.name : ''}`;
    if (node.kind === 'llm') {
      const ctx = this.buildCtx(node, event, inputs);
      const sys = render(node.prompt && node.prompt.system, ctx);
      const usr = render(node.prompt && node.prompt.user, ctx);
      key += `::${stableHash(sys)}::${stableHash(usr)}`;
    }
    key += `::${stableHash(inputs)}`;
    if (node.cache && typeof node.cache === 'object' && node.cache.version) {
      key += `::v${node.cache.version}`;
    }
    return key;
  }

  // 缓存命中：复用信封数据，但照常写黑板 / 发信号 / 处理 halt，保证下游行为不变
  replayCached(node, event, cached, t0, runs) {
    const envelope = {
      data: cached.data,
      signals: cached.signals || [],
      issues: cached.issues || [],
      meta: { node: node.id, role: node.role || node.kind, runs, ms: Date.now() - t0, cached: true },
    };
    this.envelopes[node.id] = envelope; // 覆盖式写入，与正常执行一致
    if (node.out) this.bb.set(node.out, envelope.data);
    if (node.outEnvelope) this.bb.set(node.outEnvelope, envelope);
    if (node.appendTo) this.bb.push(node.appendTo, envelope.data);

    if (Array.isArray(envelope.issues) && envelope.issues.length) {
      const all = this.bb.get('$._issues', []);
      this.bb.set('$._issues', all.concat(envelope.issues.map((i) => ({ ...i, node: node.id }))));
    }

    const signals = [...new Set([...(envelope.signals || []), ...(node.emit || [])].filter(Boolean))];
    envelope.signals = signals;
    const ms = Date.now() - t0;
    this.tracer.info('node.cached', `↺ ${node.id}  命中缓存 ${ms}ms  signals=[${signals.join(', ')}]`, { node: node.id, ms, cached: true });

    this.emit('node.done', node.id, { data: envelope.data, signals, cached: true });
    for (const s of signals) this.emit(`signal.${s}`, node.id, envelope.data);
    if (node.halt) { this.halted = true; this.haltReason = `节点 ${node.id} 声明终止`; }
    return envelope;
  }

  /* ----------------------------- 主循环 ----------------------------- */
  async run(input) {
    if (input !== undefined) this.bb.set('$.input', input);
    // $._meta 原有三字段（chain / runId / startedAt）保持不变；
    // V2 追加 W3C Trace Context 三键（来源：MCP 2026-07-28 SEP-414，见文件头注释）。
    // 上游上下文从 opts.traceContext 传入即可跨链 / 跨服务贯通同一条 trace。
    this.bb.set('$._meta', {
      chain: this.chain.id,
      runId: this.tracer.runId,
      startedAt: new Date().toISOString(),
      ...buildTraceContextV2(this.opts && this.opts.traceContext),
    });
    this.tracer.info('chain.start', `▶ ${this.chain.id} · ${this.chain.title || ''}`);

    // 基础前置链（sys.prelude）：正式链运行前统一引导（录制 / 轻量治理断言）
    // 仅当本链非 prelude 且未显式禁用（opts.preChain!==false）时执行，避免递归。
    if (this.chain.id !== 'sys.prelude' && this.opts.preChain !== false) {
      await this.runPrelude();
    }

    this.emit('chain.start', 'kernel', input ?? null);

    while (this.queue.length && !this.halted) {
      this.budget.tick('step');
      const b = this.budget.check();
      if (b) {
        if (b.level === 'exceed') {
          this.tracer.error('budget.exceeded', b.reason);
          this.emit('budget.exceeded', 'kernel', b);
          this.halted = true; this.haltReason = `预算超限：${b.reason}`;
          break;
        }
        this.tracer.warn('budget.low', b.reason);
        this.emit('budget.low', 'kernel', b);
      }

      const ev = this.queue.shift();
      if (ev.name === 'chain.end' || ev.name === 'signal.chain.end') {
        this.halted = true; this.haltReason = '收到 chain.end';
        break;
      }

      const fired = [];
      for (const node of this._candidateNodes(ev.name)) {
        const tr = this.matchTrigger(node, ev);
        if (tr) fired.push({ node, tr });
      }
      if (!fired.length) continue;

      for (const { node } of fired) {
        if (this.halted) break;
        await this.runNode(node, ev);
      }
    }

    const diagnostics = this.generateDiagnostics();
    if (diagnostics) {
      this.bb.set('$._diagnostics', diagnostics);
      this.tracer.info('diagnostics.ready', `诊断报告：${diagnostics.summary}`);
    }

    const result = {
      ok: !this.halted || this.haltReason === '收到 chain.end',
      halted: this.halted,
      haltReason: this.haltReason,
      chain: this.chain.id,
      runId: this.tracer.runId,
      blackboard: this.bb.snapshot(),
      envelopes: this.envelopes,
      budget: this.budget.report(),
      stats: this.tracer.stats(),
      // V2 追加 policies（各节点的显式缓存策略 ttlMs/scope）与 traceContext，便于回显与对账
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        enabled: !!this.cache,
        policies: this.cachePolicies || {},
        byScope: this.cache && typeof this.cache.statsByScope === 'function' ? this.cache.statsByScope() : {},
      },
      traceContext: this.bb.get('$._meta', {}).traceparent || null,
      deterministicRepairs: this.coerceHits,
      diagnostics,
    };
    this.tracer.info('chain.end', `■ ${this.chain.id} 结束 · ${this.budget.used.steps} 步 / ${this.budget.used.llmCalls} 次模型调用 / ${this.budget.elapsedMs}ms`);
    return result;
  }

  /* --------------------------- 基础前置链 --------------------------- */
  async runPrelude() {
    try {
      const preludeChain = this.loadChain('sys.prelude');
      const K = this.constructor;
      // 注意：Blackboard 存储时键名不带 $ 前缀（set('$.x') 内部 tokens 化为 'x'），
      // 故 initial 键也须不带 $，否则 get('$.x') 查 'x' 会 miss。
      const subBb = new Blackboard({
        input: this.bb.get('$.input'),
        _meta: this.bb.get('$._meta'),
        targetChain: this.chain,
        preludeRunId: this.tracer.runId,
      });
      const sub = new K({
        chain: preludeChain,
        adapter: this.adapter,
        tracer: this.tracer,
        blackboard: subBb,
        budget: this.budget,
        fns: { ...this.fns, ...preludeFns({ fns: this.fns }) },
        loadChain: this.loadChain,
        depth: this.depth + 1,
        // V2 修复：traceContext / preChain 必须是构造参数的**顶层键**（Kernel 读 this.opts.traceContext），
        // 此前错放在嵌套 opts 键里导致 prelude 拿不到上游 trace（跨链 trace 断裂）、preChain:false 成死配置。
        traceContext: this.bb.get('$._meta'),
        preChain: false,
      });
      await sub.run(this.bb.get('$.input'));
      const preludeOut = subBb.get('$.prelude');
      if (preludeOut !== undefined) this.bb.set('$.prelude', preludeOut);
      const shadowRec = subBb.get('$.shadowRecord');
      if (shadowRec !== undefined) this.bb.set('$.shadowRecord', shadowRec);
      this.tracer.info('prelude.done', '基础前置链 sys.prelude 完成');
    } catch (e) {
      // 前置失败非致命：记录但不阻断主链（前置是增强，不是硬依赖）
      this.tracer.error('prelude.fail', `前置链失败（非致命，继续主链）: ${e.message}`);
    }
  }

  /* --------------------------- 运行时诊断 --------------------------- */
  generateDiagnostics() {
    const nodes = this.chain.nodes || [];
    const diagnostics = [];

    // 1. 从未被唤醒的节点（能力缺口）
    // 排除：条件门控节点（when）、其上游条件未命中导致本不该运行的节点、迭代回路节点、终止节点
    const ranNodes = new Set(Object.keys(this.envelopes));
    const emittedEvents = new Set(['chain.start', 'budget.low', 'budget.exceeded']);
    for (const [nid, env] of Object.entries(this.envelopes)) {
      emittedEvents.add(`node.done`);
      for (const s of env.signals || []) emittedEvents.add(`signal.${s}`);
    }
    for (const n of nodes) {
      const hasWhen = (n.trigger || []).some((t) => t.when);
      const isConditional = hasWhen || /^(revise|qualityGate|review|test|gate)/i.test(n.id);
      const isTerminator = n.halt;
      // 如果该节点所有 trigger 依赖的事件都未在运行期出现，说明它被上游条件自然截断，不是缺口
      const triggers = n.trigger || [];
      const couldPossiblyRun = triggers.length === 0 || triggers.some((t) => emittedEvents.has(t.on) || t.on === '*');
      if (!ranNodes.has(n.id) && this.runs[n.id] === undefined && !isConditional && !isTerminator && couldPossiblyRun) {
        diagnostics.push({
          type: 'capabilityGap',
          severity: 'medium',
          where: n.id,
          msg: `节点 "${n.id}" 在本次运行中从未被触发，可能说明目标未命中该能力域`,
          suggestion: `若用户经常问及该领域，考虑为其新增独立 skill 或调整 trigger.when 使其更容易被命中`,
        });
      }
    }

    // 2. 反复失败的节点
    for (const [nid, runs] of Object.entries(this.runs)) {
      const node = this.nodes.get(nid);
      const maxRuns = node?.maxRuns ?? this.budget.limits.maxNodeRuns;
      if (runs >= maxRuns && (this.nodeFails?.[nid] || 0) > 0) {
        diagnostics.push({
          type: 'exhausted',
          severity: 'high',
          where: nid,
          msg: `节点 "${nid}" 已重入 ${runs} 次达到上限，可能契约不匹配或逻辑死循环`,
          suggestion: `检查 ${nid} 的 expect 契约与上游产出是否一致，或增加 maxRuns / 优化收敛条件`,
        });
      }
    }

    // 3. 发出但无订阅者的信号（运行期悬空）
    const haltNodes = new Set(nodes.filter((n) => n.halt).map((n) => n.id));
    const subscribers = new Map();
    for (const n of nodes) {
      for (const tr of n.trigger || []) {
        if (!subscribers.has(tr.on)) subscribers.set(tr.on, []);
        subscribers.get(tr.on).push(n.id);
      }
    }
    const emittedSignals = new Map(); // event -> emitter node id
    for (const [nid, env] of Object.entries(this.envelopes)) {
      for (const s of env.signals || []) emittedSignals.set(`signal.${s}`, nid);
    }
    // 只把“链作者显式保证发出”（emit）的信号纳入悬空检测；
    // declares 仅作文档（可能含 fn 内部产出标记如 assert.passed），模型角色自由产出的进度标记
    // （如 patch.done / critic.clean / critic.hasIssues）既不在 emit 也不在订阅里，不误报。
    const authorSignals = new Set();
    for (const n of nodes) {
      for (const s of (n.emit || [])) authorSignals.add(`signal.${s}`);
    }
    for (const [s, emitter] of emittedSignals) {
      if (s === 'signal.chain.end') continue;
      if (haltNodes.has(emitter)) continue; // 终止节点的信号本就不需要下游订阅
      if (!authorSignals.has(s)) continue; // 仅检测作者声明但无人订阅的接线缺口
      if (!subscribers.has(s)) {
        diagnostics.push({
          type: 'unsubscribedSignal',
          severity: 'low',
          where: s,
          msg: `信号 "${s}" 在运行期被发出但无人订阅`,
          suggestion: `删除多余信号，或新增消费该信号的节点 / skill`,
        });
      }
    }

    // 4. 预算压力
    const b = this.budget.report();
    if (b.status === 'exceeded' || b.low) {
      diagnostics.push({
        type: 'budgetPressure',
        severity: b.status === 'exceeded' ? 'critical' : 'medium',
        where: '$.budget',
        msg: `预算${b.status === 'exceeded' ? '已超限' : '偏低'}：${b.reason || ''}`,
        suggestion: '增加 budget、减少 llm 节点或拆分链',
      });
    }

    if (!diagnostics.length) return null;
    return {
      summary: `${diagnostics.length} 项诊断：${diagnostics.map((d) => d.type).join(', ')}`,
      issues: diagnostics,
      hasGaps: diagnostics.some((d) => d.type === 'capabilityGap'),
      hasExhausted: diagnostics.some((d) => d.type === 'exhausted'),
    };
  }

  /* --------------------------- 节点执行 --------------------------- */
  async runNode(node, event) {
    const runs = (this.runs[node.id] = (this.runs[node.id] || 0) + 1);
    const maxRuns = node.maxRuns ?? this.budget.limits.maxNodeRuns;
    if (runs > maxRuns) {
      this.tracer.warn('node.throttled', `${node.id} 重入 ${runs} 次超过上限 ${maxRuns}，已熔断`, { node: node.id });
      this.emit('node.throttled', node.id, { runs, maxRuns });
      return null;
    }

    const t0 = Date.now();
    this.tracer.info('node.start', `→ ${node.id}${node.title ? ' · ' + node.title : ''}  [${node.kind}]`, { node: node.id });

    let inputs = {};
    try { inputs = resolveBindings(node.in, this.buildCtx(node, event, {})); }
    catch (e) {
      this.tracer.error('node.fail', `${node.id} 输入绑定失败: ${e.message}`, { node: node.id });
      this.emit('node.fail', node.id, { error: e.message, phase: 'bind' });
      return null;
    }

    // === 信号级缓存查询（幂等 / 记忆化）===
    const cacheable = this.isCacheable(node);
    let cacheKey = null;
    if (cacheable && this.cache) {
      cacheKey = this.cacheKeyFor(node, event, inputs);
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) {
        this.cacheHits++;
        return this.replayCached(node, event, hit, t0, runs);
      }
    }
    if (this.cache) this.cacheMisses++;

    let envelope;
    try {
      switch (node.kind) {
        case 'llm': envelope = await this.execLlm(node, event, inputs); break;
        case 'fn': envelope = await this.execFn(node, event, inputs); break;
        case 'gate': envelope = this.execGate(node, event, inputs); break;
        case 'map': envelope = await this.execMap(node, event, inputs); break;
        case 'chain': envelope = await this.execChain(node, event, inputs); break;
        case 'loop': envelope = this.execLoop(node, event, inputs); break;
        default: throw new Error(`未知节点类型 ${node.kind}`);
      }
    } catch (e) {
      this.nodeFails = this.nodeFails || {};
      this.nodeFails[node.id] = (this.nodeFails[node.id] || 0) + 1;
      const ms = Date.now() - t0;
      this.tracer.error('node.fail', `${node.id} 执行异常: ${e.message}`, { node: node.id, ms });
      this.emit('node.fail', node.id, { error: e.message, node: node.id });
      this.emit('signal.error', node.id, { error: e.message, node: node.id });
      if (node.onError && node.onError.emit) for (const s of node.onError.emit) this.emit(`signal.${s}`, node.id, { error: e.message });
      return null;
    }

    // 归档信封
    envelope.meta = { node: node.id, role: node.role || node.kind, runs, ms: Date.now() - t0, ...(envelope.meta || {}) };
    this.envelopes[node.id] = envelope;

    // 写黑板
    if (node.out) this.bb.set(node.out, envelope.data);
    if (node.outEnvelope) this.bb.set(node.outEnvelope, envelope);
    if (node.appendTo) this.bb.push(node.appendTo, envelope.data);

    // 汇总 issues
    if (Array.isArray(envelope.issues) && envelope.issues.length) {
      const all = this.bb.get('$._issues', []);
      this.bb.set('$._issues', all.concat(envelope.issues.map((i) => ({ ...i, node: node.id }))));
    }

    // 去重至关重要：模型返回的 signals 与节点声明的 emit 经常重叠，
    // 不去重会导致同一信号发两次，下游节点被重复唤醒并在链上级联放大成指数级浪费。
    const signals = [...new Set([...(envelope.signals || []), ...(node.emit || [])].filter(Boolean))];
    envelope.signals = signals;

    const ms = Date.now() - t0;
    this.tracer.info('node.done', `✓ ${node.id}  ${ms}ms  signals=[${signals.join(', ')}]`, { node: node.id, ms });

    this.emit('node.done', node.id, { data: envelope.data, signals });
    for (const s of signals) this.emit(`signal.${s}`, node.id, envelope.data);

    if (node.halt) { this.halted = true; this.haltReason = `节点 ${node.id} 声明终止`; }

    // === 写缓存（仅缓存确定性可复用的信封部分：data/signals/issues）===
    if (cacheable && this.cache && cacheKey && envelope) {
      const ttl = (node.cache && typeof node.cache === 'object' && node.cache.ttl) ? node.cache.ttl : undefined;
      const payload = { data: envelope.data, signals: envelope.signals, issues: envelope.issues };
      // V2：缓存新鲜度显式化（ttlMs + scope），来源 MCP 2026-07-28 SEP-2549，见文件头注释
      const policyV2 = resolveCachePolicyV2(node, ttl);
      this.cachePolicies = this.cachePolicies || {};
      this.cachePolicies[node.id] = policyV2;
      if (this.cache && typeof this.cache.setScoped === 'function') {
        this.cache.setScoped(cacheKey, payload, policyV2);
      } else {
        // 兼容旧版 / 自定义缓存实例（无 setScoped）：退回原 set(key, value, ttlMs)，行为不变
        this.cache.set(cacheKey, payload, ttl);
      }
    }
    return envelope;
  }

  /* ------------------------------ LLM ------------------------------ */
  async execLlm(node, event, inputs) {
    if (!this.adapter) throw new Error('未配置模型适配器（adapter）');
    const ctx = this.buildCtx(node, event, inputs);
    const sys = render(node.prompt?.system, ctx);
    const usr = render(node.prompt?.user, ctx);
    const maxRetry = node.retry?.max ?? 2;

    // 受限生成：node.format 控制适配器请求的结构化输出形态
    const fmt = node.format;
    let wantJson = true;
    let outSchema = null;
    if (fmt === 'text') wantJson = false;
    else if (fmt && typeof fmt === 'object') {
      if (fmt.type && fmt.type !== 'json') wantJson = false;
      if (fmt.schema) outSchema = fmt.schema;
    }
    const structSchema = outSchema || (wantJson ? node.expect : null);

    let attempt = 0, feedback = '';
    for (;;) {
      attempt++;
      this.budget.tick('llm');
      this.budget.tick('token', estimateTokens(sys) + estimateTokens(usr) + estimateTokens(feedback));

      const raw = await this.adapter.complete({
        system: sys,
        user: feedback ? `${usr}\n\n【上一次输出存在问题，请修正后重新只输出 JSON】\n${feedback}` : usr,
        role: node.role,
        node: node.id,
        json: wantJson,
        schema: structSchema,
        temperature: node.temperature,
      });
      this.budget.tick('token', estimateTokens(raw));

      // 纯文本模式：不强制 JSON，直接落盘为 data.text
      if (!wantJson) {
        return { data: { text: String(raw) }, signals: [], issues: [] };
      }

      const rep = repair(raw);
      if (!rep.ok) {
        this.tracer.warn('json.repair', `${node.id} 第 ${attempt} 次输出无法解析为 JSON：${rep.error}`, { node: node.id });
        if (attempt > maxRetry) throw new Error(`模型输出始终无法解析为 JSON（${rep.error}）`);
        feedback = `输出不是合法 JSON：${rep.error}。请只输出一个 JSON 对象，不要任何解释文字或代码围栏。`;
        continue;
      }
      if (rep.method !== 'direct' && rep.method !== 'passthrough') {
        this.tracer.warn('json.repair', `${node.id} 输出经 ${rep.method} 修复后可解析`, { node: node.id });
      }

      let env = rep.value;
      // 容错：模型只吐了 data 本体而没套信封
      if (env && typeof env === 'object' && env.data === undefined) env = { data: env, signals: [], issues: [] };
      env.signals = Array.isArray(env.signals) ? env.signals : [];
      env.issues = Array.isArray(env.issues) ? env.issues : [];

      // 确定性修复：不重调 LLM，尽量用 schema 强制/回填把 data 修到合规（省 token）
      if (node.expect) {
        const dr = repairData(env, node.expect);
        if (dr.changed) {
          this.coerceHits++;
          this.tracer.info('schema.coerced', `${node.id} 确定性修复 ${dr.applied.length} 处，省去 LLM 重试`, { node: node.id, applied: dr.applied });
          env = dr.env;
        }
      }

      const envCheck = validate(env, ENVELOPE_SCHEMA);
      const dataCheck = node.expect ? validate(env.data, node.expect) : { ok: true, errors: [] };

      if (envCheck.ok && dataCheck.ok) return env;

      const errs = explain([...envCheck.errors, ...dataCheck.errors]);
      this.tracer.warn('schema.invalid', `${node.id} 第 ${attempt} 次输出不满足契约:\n${errs}`, { node: node.id });
      if (attempt > maxRetry) {
        if (node.retry?.onExhausted === 'passthrough') {
          env.issues.push({ severity: 'medium', where: node.id, msg: `契约校验未通过但已放行：${errs}` });
          return env;
        }
        throw new Error(`输出契约校验失败（已重试 ${attempt} 次）：\n${errs}`);
      }
      feedback = `你的 JSON 不满足契约，问题如下：\n${errs}\n请修正这些字段后重新输出完整 JSON。`;
    }
  }

  /* --------------------------- 函数节点 --------------------------- */
  async execFn(node, event, inputs) {
    const fn = this.fns[node.use];
    if (!fn) throw new Error(`未注册的函数节点 ${node.use}`);
    const exprCtx = this.buildCtx(node, event, inputs);
    const r = await fn(inputs, { bb: this.bb, tracer: this.tracer, node, event, exprCtx, evaluate, kernel: this, chain: { id: this.chain.id, title: this.chain.title } });
    return { data: r?.data ?? {}, signals: r?.signals || [], issues: r?.issues || [], next: r?.next };
  }

  /* ---------------------------- 网关节点 ---------------------------- */
  execGate(node, event, inputs) {
    const ctx = this.buildCtx(node, event, inputs);
    const cases = node.cases || [];
    for (const c of cases) {
      if (!c.when || test(c.when, ctx)) {
        this.tracer.info('gate.pick', `${node.id} 命中分支 "${c.label || c.emit}"`, { node: node.id });
        const sig = Array.isArray(c.emit) ? c.emit : [c.emit].filter(Boolean);
        // 显式短路：命中带 bail 的分支且节点开启 shortCircuit → 整链立即终止
        // （与 node.halt 语义一致：haltReason 非 '收到 chain.end'，故 result.ok=false）
        if (node.shortCircuit && c.bail) {
          this.halted = true;
          this.haltReason = `gate ${node.id} 命中 bail 分支 "${c.label || c.emit}"，整链短路终止`;
        }
        return {
          data: { branch: c.label || c.emit, matched: c.when || 'default', reason: c.reason || '' },
          signals: sig,
        };
      }
    }
    const d = node.default;
    // 显式声明了 default 就说明这是设计好的兜底路径，不是异常
    if (node.shortCircuit && node.bailOnDefault && d) {
      this.halted = true;
      this.haltReason = `gate ${node.id} 默认分支触发整链短路终止`;
    }
    this.tracer[d ? 'info' : 'warn']('gate.default',
      d ? `${node.id} 全部分支未命中，走声明的默认路径` : `${node.id} 未命中任何分支且未声明 default`,
      { node: node.id });
    return { data: { branch: 'default', matched: null }, signals: d ? (Array.isArray(d) ? d : [d]) : ['gate.nomatch'] };
  }

  /* ---------------------------- 循环节点 ---------------------------- */
  execLoop(node, event, inputs) {
    const path = node.counterPath || `$._loops.${node.id.replace(/\./g, '_')}`;
    const round = Number(this.bb.get(path, 0)) + 1;
    this.bb.set(path, round);
    const maxRounds = Number(node.maxRounds) || 3;
    const ctx = this.buildCtx(node, event, { ...inputs, round });
    const keepGoing = round <= maxRounds && (node.while ? test(node.while, ctx) : true);
    this.tracer.info('loop.tick', `${node.id} 第 ${round}/${maxRounds} 轮 → ${keepGoing ? '继续' : '退出'}`, { node: node.id });
    return {
      data: { round, maxRounds, continue: keepGoing },
      signals: keepGoing ? (Array.isArray(node.body) ? node.body : [node.body || 'loop.body']) : (Array.isArray(node.done) ? node.done : [node.done || 'loop.done']),
    };
  }

  /* ----------------------------- map 节点 ----------------------------- */
  async execMap(node, event, inputs) {
    const ctx = this.buildCtx(node, event, inputs);
    let list = evaluate(node.over, ctx);
    if (!Array.isArray(list)) list = list ? [list] : [];
    const limit = Number(node.limit) || 20;
    list = list.slice(0, limit);

    const results = [];
    const failures = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      this.tracer.info('map.item', `${node.id} 处理第 ${i + 1}/${list.length} 项`, { node: node.id });
      try {
        if (node.use) {
          // 每项跑一条子链
          const sub = await this.spawnSubChain(node.use, { item, index: i, parent: this.bb.snapshot() }, node);
          results.push({ index: i, item, ok: true, output: sub.blackboard.output ?? sub.blackboard, envelopes: Object.keys(sub.envelopes) });
        } else if (node.fn) {
          const fn = this.fns[node.fn];
          if (!fn) throw new Error(`未注册函数 ${node.fn}`);
          const r = await fn({ ...inputs, item, index: i }, { bb: this.bb, tracer: this.tracer, node, event, exprCtx: ctx, evaluate, kernel: this });
          results.push({ index: i, item, ok: true, output: r?.data });
        } else {
          results.push({ index: i, item, ok: true, output: item });
        }
      } catch (e) {
        this.tracer.error('map.fail', `${node.id} 第 ${i + 1} 项失败: ${e.message}`, { node: node.id });
        failures.push({ index: i, item, error: e.message });
        results.push({ index: i, item, ok: false, error: e.message });
        if (node.onItemError === 'abort') throw e;
      }
    }
    return {
      data: { total: list.length, results, outputs: results.filter((r) => r.ok).map((r) => r.output), failures },
      signals: failures.length ? ['map.partial', 'map.done'] : ['map.done'],
      issues: failures.map((f) => ({ severity: 'medium', where: `${node.id}[${f.index}]`, msg: f.error })),
    };
  }

  /* ---------------------------- 子链节点 ---------------------------- */
  async execChain(node, event, inputs) {
    const sub = await this.spawnSubChain(node.use, inputs, node);
    return {
      data: node.pick ? (sub.blackboard[node.pick] ?? sub.blackboard) : sub.blackboard,
      signals: [...(sub.ok ? [`${node.id}.ok`] : [`${node.id}.failed`]), ...(node.emit || [])],
      issues: (sub.blackboard._issues || []),
      meta: { subChain: sub.chain, subRun: sub.runId, subSteps: sub.stats.totalRecords },
    };
  }

  async spawnSubChain(ref, input, node) {
    if (this.depth >= this.maxDepth) throw new Error(`子链嵌套超过最大深度 ${this.maxDepth}`);
    const chain = this.loadChain(ref);
    const kernel = new Kernel({
      chain,
      adapter: this.adapter,
      tracer: this.tracer,
      budget: this.budget,
      fns: this.fns,
      loadChain: this.loadChain,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      initial: { input, _parent: { chain: this.chain.id, node: node?.id } },
      // V2 修复：透传 W3C trace context，chain/map 子链与父链同一条 trace（此前未传，跨链贯通实际断裂）
      traceContext: this.bb.get('$._meta'),
      // 顶层运行若显式禁用了前置链，子链一并继承该选择
      ...(this.opts && this.opts.preChain === false ? { preChain: false } : {}),
    });
    this.tracer.info('chain.spawn', `↳ 进入子链 ${chain.id}（深度 ${this.depth + 1}）`, { node: node?.id });
    return kernel.run(input);
  }
}

module.exports = { Kernel, render, resolveBindings, ENVELOPE_SCHEMA };
