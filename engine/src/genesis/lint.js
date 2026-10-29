'use strict';
/**
 * lint.js —— 链定义静态检查器
 *
 * 生成一条「看起来像样」的链很容易，难的是判断它到底能不能跑。
 * 这里做四类检查，每一类都对应一种真实会把系统搞挂的故障：
 *
 *   A. 结构合法性   —— 字段缺失、类型错误、kind 与必备字段不匹配
 *   B. 图可达性     —— 从 chain.start 出发，哪些节点永远不会被唤醒（孤儿）
 *   C. 终止性与环路 —— 有没有出口？环上有没有刹车？
 *   D. 数据流       —— 引用了从没有人写过的黑板路径（幽灵依赖）
 *
 * 每条规则有稳定编号（L0xx），方便「自我找 bug」链引用与回归。
 * 严重度：error 必须修；warn 建议修；info 提示。
 */

const { validate } = require('../engine/validator');
const chainSchema = require('../../schemas/chain.schema.json');
const { evaluate: evaluateGovernance } = require('./governance');

/* ---------------- 验收门体系：功能/静态/性能/安全/回归/治理 ---------------- */
const GATES = ['functional', 'static', 'performance', 'security', 'regression', 'governance'];

const KIND_REQUIRED = {
  llm: ['prompt'],
  fn: ['use'],
  gate: ['cases'],
  map: ['over'],
  chain: ['use'],
  loop: [],
};

/** 内置函数节点的固定信号表：静态分析需要知道 fn 会吐什么 */
const FN_SIGNALS = {
  noop: ['noop.done'],
  intake: ['intake.ready', 'intake.invalid'],
  set: ['set.done'],
  merge: ['merge.done'],
  collect: ['collect.done'],
  assert: ['assert.passed', 'assert.failed'],
  score: ['score.done', 'score.empty'],
  slice: ['slice.done'],
  counter: ['counter.tick', 'counter.exhausted'],
  diff: ['diff.changed', 'diff.same'],
  converge: ['iterate.converged', 'iterate.continue'],
  groupBy: ['group.done'],
  traceStats: ['trace.ready'],
  deliver: ['deliver.done', 'chain.end'],
  readCorpus: ['styleCorpus.ready'],
};

/** 静态推断某节点可能发出的所有信号名（不含 signal. 前缀） */
function declaredSignals(node, fnSignals) {
  const s = new Set([...(node.declares || []), ...(node.emit || [])]);
  switch (node.kind) {
    case 'fn': {
      const known = (fnSignals || FN_SIGNALS)[node.use];
      if (known) known.forEach((x) => s.add(x));
      break;
    }
    case 'gate': {
      for (const c of node.cases || []) {
        (Array.isArray(c.emit) ? c.emit : [c.emit]).filter(Boolean).forEach((x) => s.add(x));
      }
      const d = node.default;
      if (d) (Array.isArray(d) ? d : [d]).forEach((x) => s.add(x));
      else s.add('gate.nomatch');
      break;
    }
    case 'loop': {
      (Array.isArray(node.body) ? node.body : [node.body || 'loop.body']).forEach((x) => s.add(x));
      (Array.isArray(node.done) ? node.done : [node.done || 'loop.done']).forEach((x) => s.add(x));
      break;
    }
    case 'map':
      s.add('map.done'); s.add('map.partial');
      break;
    case 'chain':
      s.add(`${node.id}.ok`); s.add(`${node.id}.failed`);
      break;
    default:
      break;
  }
  return [...s];
}

/** 节点执行后一定会产生的事件全集（含内核自动事件） */
function producedEvents(node, fnSignals) {
  const evts = new Set(['node.done']);
  for (const s of declaredSignals(node, fnSignals)) evts.add(`signal.${s}`);
  return { events: [...evts], from: node.id };
}

function collectRefs(obj, out = new Set()) {
  if (obj == null) return out;
  if (typeof obj === 'string') {
    const re = /\$\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g;
    let m;
    while ((m = re.exec(obj))) out.add(m[2] ? `$.${m[1]}.${m[2]}` : `$.${m[1]}`);
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach((v) => collectRefs(v, out)); return out; }
  if (typeof obj === 'object') { Object.values(obj).forEach((v) => collectRefs(v, out)); return out; }
  return out;
}

function lint(chain, opts = {}) {
  const findings = [];
  const add = (level, rule, where, msg, fix) => findings.push({ level, rule, where, msg, ...(fix ? { fix } : {}) });

  const knownFns = opts.knownFns ? new Set(opts.knownFns) : null;
  const knownChains = opts.knownChains ? new Set(opts.knownChains) : null;
  const fnSignals = { ...FN_SIGNALS, ...(opts.fnSignals || {}) };

  /* ---------------- A. 结构 ---------------- */
  if (!chain || typeof chain !== 'object') {
    return { ok: false, score: 0, findings: [{ level: 'error', rule: 'L001', where: '$', msg: '链不是一个对象' }], summary: {} };
  }

  const schemaCheck = validate(chain, chainSchema);
  for (const e of schemaCheck.errors) add('error', 'L001', e.path, `不符合链元 Schema：${e.msg}`);

  const nodes = Array.isArray(chain.nodes) ? chain.nodes : [];
  const ids = new Set();
  for (const n of nodes) {
    const w = `nodes.${n.id || '?'}`;
    if (!n.id) { add('error', 'L002', w, '节点缺少 id'); continue; }
    if (ids.has(n.id)) add('error', 'L002', w, `节点 id 重复：${n.id}`);
    ids.add(n.id);

    for (const f of KIND_REQUIRED[n.kind] || []) {
      if (n[f] === undefined) add('error', 'L003', w, `kind=${n.kind} 缺少必备字段 "${f}"`, `补上 ${f}`);
    }
    if (n.kind === 'llm') {
      if (!n.prompt?.user) add('error', 'L003', w, 'llm 节点缺少 prompt.user');
      if (!n.expect) add('warn', 'L009', w, 'llm 节点没有 expect 输出契约，模型跑偏时无法被拦截', '补一个 expect Schema，哪怕只约束顶层必填字段');
      if (!n.role) add('warn', 'L003', w, 'llm 节点建议声明 role，便于模板复用与 mock 演练');
    }
    if (n.kind === 'fn' && knownFns && !knownFns.has(n.use)) {
      add('error', 'L011', w, `引用了未注册的函数 "${n.use}"`);
    }
    if ((n.kind === 'chain' || (n.kind === 'map' && n.use)) && knownChains && !knownChains.has(n.use)) {
      add('error', 'L012', w, `引用了不存在的子链 "${n.use}"`);
    }
    if (n.kind === 'gate' && !(n.cases || []).length) add('error', 'L003', w, 'gate 节点 cases 为空');
    if (n.kind === 'gate') {
      const hasBailCase = (n.cases || []).some((c) => c.bail === true);
      if (n.shortCircuit === true && !hasBailCase && !n.bailOnDefault) {
        add('warn', 'L022', w, 'shortCircuit:true 但没有任何分支声明 bail:true 或 bailOnDefault，短路永不触发（死配置）',
          '给某个分支加 bail:true，或设 bailOnDefault:true 且提供 default');
      }
      if (hasBailCase && n.shortCircuit !== true) {
        add('warn', 'L022', w, '存在 bail:true 分支但 shortCircuit 未开启，bail 标志无效（分支仍只发信号、不终止链）',
          '设 shortCircuit:true 让 bail 分支真正短路整链');
      }
    }
    if (n.kind === 'llm' && n.format) {
      if (typeof n.format === 'object') {
        if (n.format.type && n.format.type !== 'json' && n.format.schema) {
          add('warn', 'L023', w, 'format.schema 仅在 format.type==="json" 时生效，当前 type 非 json 会被忽略', '把 type 设为 "json" 或移除 schema');
        }
        if (n.format.type === 'json' && n.format.schema && n.expect && JSON.stringify(n.format.schema) !== JSON.stringify(n.expect)) {
          add('warn', 'L023', w, 'format.schema 与 node.expect 不一致：结构化输出请求以 format.schema 为准，expect 仍用于返回后校验', '让两者保持一致，避免模型按一份 schema 生成却被另一份判失败');
        }
      } else if (n.format !== 'json' && n.format !== 'text') {
        add('error', 'L023', w, `node.format 非法（${JSON.stringify(n.format)}），应为 "json" | "text" | { type:"json", schema }`, '改成合法取值');
      }
    }
    // L025：retry.onExhausted 取值合法性
    // 内核（kernel.js execLlm）只识别 'passthrough'：命中则放行并附一条 medium issue；
    // 其余任何值（含 'throw'）都走同一条 throw 分支 —— 重试耗尽即抛错终止链。
    // 所以写 "coerce" / "emit-issue" / "fallback" 这类"以为内核支持"的值不会报错，
    // 只会静默按 throw 处理，契约本就宽松的节点因此莫名挂掉。
    // 注：schema 里的 enum["throw","passthrough"] 本可拦截，但 validator 不支持 $ref，
    // nodes.items 指向 #/definitions/node 未被解析，整棵节点子树 schema 校验失效 —— 故在 lint 侧兜底。
    // 编号说明：L024 已由 docs/trigger-chain-plugin-standard.md §13.1 预留给 plugin-manifest 规则，故取 L025。
    if (n.retry && Object.prototype.hasOwnProperty.call(n.retry, 'onExhausted')) {
      const oe = n.retry.onExhausted;
      if (typeof oe !== 'string') {
        add('warn', 'L025', `${w}.retry.onExhausted`,
          `onExhausted 必须是字符串，当前为 ${JSON.stringify(oe)}，内核将按 throw 处理（重试耗尽即抛错）`,
          '改成 "throw"（严格）或 "passthrough"（放行并记一条 issue）');
      } else if (oe !== 'throw' && oe !== 'passthrough') {
        add('warn', 'L025', `${w}.retry.onExhausted`,
          `onExhausted="${oe}" 不是内核识别的取值：只有 "passthrough" 会在重试耗尽后放行（并附一条 medium issue），其余任何值一律按 throw 抛错终止链，你写的这个意图不会生效`,
          '想要"尽力修复后放行"用 "passthrough"（内核已有 repairData 确定性修复兜底）；想要严格失败用 "throw"');
      }
    }
    if (!(n.trigger || []).length) add('error', 'L003', w, '节点没有任何 trigger，永远不会被唤醒');
    if (!declaredSignals(n, fnSignals).length && !n.halt) {
      add('warn', 'L013', w, '节点既不声明任何信号也不 halt，属于链路死角（后续无人可被它唤醒）', '补 declares 或设 halt:true');
    }
  }

  /* ---------------- B. 可达性 ---------------- */
  const available = new Set(['chain.start', 'budget.low', 'budget.exceeded']);
  const availableFrom = new Set();
  const reached = new Set();
  const wakeEdges = [];

  const matches = (tr, evt, from) => {
    if (tr.on !== '*' && tr.on !== evt) return false;
    if (tr.from && tr.from !== from) return false;
    return true;
  };

  let changed = true, guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const n of nodes) {
      if (reached.has(n.id)) continue;
      const hit = (n.trigger || []).some((tr) =>
        [...available].some((e) => matches(tr, e, undefined)) ||
        [...availableFrom].some((ef) => { const [e, f] = ef.split('@@'); return matches(tr, e, f); }));
      if (hit) {
        reached.add(n.id);
        const p = producedEvents(n, fnSignals);
        for (const e of p.events) { available.add(e); availableFrom.add(`${e}@@${p.from}`); }
        changed = true;
      }
    }
  }

  for (const n of nodes) {
    if (!reached.has(n.id)) {
      const ons = (n.trigger || []).map((t) => t.on + (t.from ? `@${t.from}` : '')).join(', ');
      add('error', 'L004', `nodes.${n.id}`, `孤儿节点：订阅的事件 [${ons}] 在本链中永远不会出现`,
        '检查上游节点的 declares 是否遗漏了这个信号，或把 trigger 改为已存在的信号');
    }
  }

  // 建立 信号 → 订阅者 索引，用于悬空信号检测与环路分析
  const subscribers = new Map(); // eventName -> [nodeId]
  for (const n of nodes) {
    for (const tr of n.trigger || []) {
      const key = tr.on;
      if (!subscribers.has(key)) subscribers.set(key, []);
      subscribers.get(key).push(n.id);
    }
  }
  for (const n of nodes) {
    for (const s of declaredSignals(n, fnSignals)) {
      if (s === 'chain.end') continue;
      const evt = `signal.${s}`;
      const subs = subscribers.get(evt) || subscribers.get('*') || [];
      if (!subs.length) {
        add('info', 'L005', `nodes.${n.id}`, `信号 "${s}" 没有任何订阅者，发出后即消散`,
          '要么删掉这个信号，要么补一个订阅它的节点');
      }
      wakeEdges.push(...(subs.map((to) => ({ from: n.id, to, via: s }))));
    }
  }

  /* ---------------- C. 终止性与环路 ---------------- */
  const terminators = nodes.filter((n) => n.halt || declaredSignals(n, fnSignals).includes('chain.end'));
  if (!terminators.length) {
    add('error', 'L006', '$', '这条链没有任何终止节点：既没有 halt:true 也没有节点发出 chain.end 信号，只能靠预算熔断收场',
      '在链尾加一个 fn deliver 节点，或给终点节点设 halt:true');
  } else {
    const reachableTerm = terminators.filter((t) => reached.has(t.id));
    if (!reachableTerm.length) add('error', 'L006', '$', '存在终止节点，但它们都不可达');
  }

  // 环路检测（DFS 找回边）
  const adj = new Map();
  for (const e of wakeEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const cycles = [];
  const color = new Map();
  const stack = [];
  const dfs = (u) => {
    color.set(u, 1); stack.push(u);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === 1) {
        const i = stack.indexOf(v);
        cycles.push(stack.slice(i >= 0 ? i : 0).concat(v));
      } else if (!color.has(v)) dfs(v);
    }
    stack.pop(); color.set(u, 2);
  };
  for (const n of nodes) if (!color.has(n.id)) dfs(n.id);

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const seenCycle = new Set();
  for (const cyc of cycles) {
    const key = [...new Set(cyc)].sort().join('>');
    if (seenCycle.has(key)) continue;
    seenCycle.add(key);
    const braked = cyc.some((id) => {
      const n = nodeById.get(id);
      return n && (n.maxRuns != null || n.kind === 'loop' || (n.kind === 'fn' && ['counter', 'converge'].includes(n.use)));
    });
    if (!braked) {
      add('error', 'L007', cyc.join(' → '), `检测到无刹车环路：${cyc.join(' → ')}。这条链会一直转到预算熔断为止`,
        '给环上至少一个节点设 maxRuns，或插入 fn:converge / fn:counter 做收敛判定');
    } else {
      add('info', 'L007', cyc.join(' → '), `环路 ${cyc.join(' → ')} 已有刹车，属于合法的迭代回路`);
    }
  }

  /* ---------------- D. 数据流 ---------------- */
  const writes = new Set(['$.input', '$._meta', '$._issues', '$._loops', '$._counters']);
  for (const n of nodes) {
    for (const p of [n.out, n.outEnvelope, n.appendTo, n.counterPath]) {
      if (typeof p === 'string' && p.startsWith('$.')) {
        const seg = p.split(/[.[]/).slice(0, 2).join('.');
        writes.add(seg);
        writes.add(p);
      }
    }
    // fn 节点可以通过 ctx.bb.set() 写 out 之外的任意路径（引擎允许，见 functions.js 内 builtins）。
    // 这类写入 lint 无法静态推断，会被 L008 误判为幽灵依赖。
    // 处理原则：不放宽检查，而是要求节点用 `writes: ["$.x", ...]` 显式申报副作用写入路径
    // —— 把「fn 偷偷写黑板」变成建制层的显式契约。未申报的仍然报 L008。
    if (Array.isArray(n.writes)) {
      for (const p of n.writes) {
        if (typeof p === 'string' && p.startsWith('$.')) {
          writes.add(p.split(/[.[]/).slice(0, 2).join('.'));
          writes.add(p);
        }
      }
    }
  }
  for (const n of nodes) {
    // 提示词里只有 {{ }} 插值才是真实引用，正文里出现的 $.x 是写给模型看的文档，不能当依赖
    const interpolations = [];
    for (const s of [n.prompt?.system, n.prompt?.user]) {
      if (typeof s !== 'string') continue;
      let m; const re = /\{\{([\s\S]+?)\}\}/g;
      while ((m = re.exec(s))) interpolations.push(m[1]);
    }
    const refs = collectRefs({ in: n.in, tpl: interpolations, cases: n.cases, over: n.over, while: n.while, trigger: n.trigger });
    for (const r of refs) {
      const top = r.split('.').slice(0, 2).join('.');
      if (![...writes].some((w) => w === r || w === top || r.startsWith(w))) {
        add('warn', 'L008', `nodes.${n.id}`, `引用了从未被写入的黑板路径 "${r}"（幽灵依赖，运行时会拿到 undefined）`,
          `确认哪个上游节点应该 out 到 ${top}`);
      }
    }
  }

  /* ---------------- D2. 保留键撞车 ---------------- */
  // 内核对 conditions / cases 这两个键不做求值。若节点 in 里用了同名键又写了 $ 路径，
  // 该路径会被原样当字面量传进节点——不报错，只在下游悄悄泄漏一个字符串。
  const RESERVED_IN_KEYS = ['conditions', 'cases'];
  for (const n of nodes) {
    if (!n.in || typeof n.in !== 'object') continue;
    for (const k of RESERVED_IN_KEYS) {
      const v = n.in[k];
      const leaks = typeof v === 'string' ? v.startsWith('$') : JSON.stringify(v || '').includes('"$.');
      if (v !== undefined && leaks && n.kind !== 'fn') {
        add('warn', 'L016', `nodes.${n.id}.in.${k}`,
          `"${k}" 是内核保留键，其子树不会被求值，里面的 $ 路径会原样变成字符串字面量`,
          `把参数改名，或在函数内部自行用 ctx.evaluate 求值`);
      }
    }
  }

  /* ---------------- E0. 红线与建制机器化（v0.1.0） ----------------
   图谱来源：「带 AI 打仗」治理框架——红线 5 条（不能定义成功标准 / 伪造证据 / 跳过门 / 破坏边界 / 丢证据）
   机器化策略：① redlines 升级为结构化对象；② 声明 immutable；③ 禁止 prompt 覆盖 rubric/redlines 路径；④ 必跑门检查。
*/
function checkRedlinesAndRubric(chain, add) {
  // L018：evidenceManifestSpec 契约校验（证据层军报的不可篡改 / 第三方可验证基础）
  if (chain.evidenceManifestSpec !== undefined) {
    const ems = chain.evidenceManifestSpec;
    const required = ['products', 'hashAlgorithm', 'hashChain', 'gitShaBinding', 'thirdPartyVerifiable'];
    const missing = required.filter((k) => !(k in ems));
    if (missing.length) {
      add('warn', 'L018', '$.evidenceManifestSpec',
        `evidenceManifestSpec 缺关键字段：${missing.join(', ')}`,
        '补全 products / hashAlgorithm / hashChain / gitShaBinding / thirdPartyVerifiable');
    }
  } else {
    add('info', 'L018', '$', '未声明 evidenceManifestSpec；证据层军报将是弱约束（仅内存 manifest，不可第三方验证）',
      '治理化建议补 evidenceManifestSpec');
  }

  // L019：redlines 必须是结构化对象（version/immutable/items）
  if (chain.redlines !== undefined) {
    if (Array.isArray(chain.redlines)) {
      add('warn', 'L019', '$.redlines',
        'redlines 是字符串数组，机器无法判定「何时何类」触发。',
        '升级为 {version, immutable, categoryList, items[{id,category,text,severity,regex?}]} 机器可读结构');
    } else if (typeof chain.redlines === 'object' && chain.redlines !== null) {
      if (!chain.redlines.version) {
        add('warn', 'L019', '$.redlines', 'redlines 缺少 version 字段', '加 "version":"x.y.z"');
      }
      if (chain.redlines.immutable !== true) {
        add('warn', 'L019', '$.redlines', 'redlines 未声明 immutable=true（人设红线，运行时不得被改写）',
          '加 "immutable":true');
      }
      if (!Array.isArray(chain.redlines.items) || chain.redlines.items.length === 0) {
        add('error', 'L019', '$.redlines.items', 'redlines.items 必须为非空数组');
      } else {
        const ids = new Set();
        for (const it of chain.redlines.items) {
          if (!it.id) add('error', 'L019', '$.redlines.items[].id', 'redline 缺 id');
          if (ids.has(it.id)) add('error', 'L019', '$.redlines.items[].id', `redline id 重复：${it.id}`);
          ids.add(it.id);
          if (it.severity === 'block' && it.veto === true && typeof it.regex !== 'string') {
            add('warn', 'L019', `$.redlines.items[${it.id}]`, 'veto 红线建议配 regex 以便 review 节点机器化判定');
          }
        }
      }
    } else {
      add('error', 'L019', '$.redlines', 'redlines 必须是数组（已弃用）或对象');
    }
  }

  // L020：reviewRubricMeta 必须存在 + rubricImmutable + review 节点不能 prompt-side 覆盖 rubric 路径
  const meta = chain.reviewRubricMeta || {};
  if (chain.reviewRubric !== undefined) {
    if (!meta.rubricVersion) {
      add('warn', 'L020', '$.reviewRubricMeta', '缺 rubricVersion；升级 v0.1.0 时建议显式声明',
        '加 {rubricVersion:"x.y.z", rubricImmutable:true, passRule, scoringFormula, thresholdStrategy}');
    }
    if (meta.rubricImmutable !== true) {
      add('warn', 'L020', '$.reviewRubricMeta.rubricImmutable',
        'rubric 未声明 immutable=true；战略层成功标准不得被 AI 单方修改',
        '加 "rubricImmutable":true');
    }

    // 防止 review 节点 prompt 引用可被外部改写的 rubric 路径
    for (const n of chain.nodes || []) {
      if (n.role !== 'critic') continue;
      const allText = JSON.stringify([n.prompt?.system, n.prompt?.user]);
      if (/\{\{\s*\$\.(?:reviewRubric|rubricMeta|redlines)(?:_override)?/i.test(allText)) {
        add('warn', 'L020', `nodes.${n.id}`,
          'review 节点 prompt 引用了可被覆盖的 rubric/redlines 路径（违反红线「不能定义成功标准」）',
          '将 review 的评分规则硬编码进 prompt，不引用动态路径');
      }
    }
  }

  // L021：运行时门数检查；v0.1.0 治理框架要求 5 道门（功能/静态/安全/风格/回归）
  const gateNodes = (chain.nodes || []).filter((n) => n.kind === 'gate');
  if (gateNodes.length === 0) {
    add('error', 'L021', '$', '运行时无任何 gate 节点，结果完全由 AI 自述裁定，违反红线「跳过验收门」',
      '至少加一个 gate 节点（功能门 qualityGate）');
  } else if (gateNodes.length < 5) {
    add('warn', 'L021', '$', `运行时 gate 节点数 = ${gateNodes.length}；v0.1.0 治理框架要求 ≥5 道门（功能/静态/安全/风格/回归）`,
      '补齐 lintGate / safetyGate / styleGate / regressionGate');
  }
}
checkRedlinesAndRubric(chain, add);

/* ---------------- E. 预算 ---------------- */
  const llmCount = nodes.filter((n) => n.kind === 'llm').length;
  const b = chain.budget || {};
  if (!chain.budget) {
    add('warn', 'L010', '$.budget', '未声明 budget，将使用全局默认值', '显式声明预算，链的成本才可预测');
  } else if (b.maxLlmCalls != null && b.maxLlmCalls < llmCount) {
    add('error', 'L010', '$.budget.maxLlmCalls', `预算 maxLlmCalls=${b.maxLlmCalls} 小于 llm 节点数 ${llmCount}，链必然中途熔断`);
  }
  if (!chain.acceptance || !chain.acceptance.length) {
    add('info', 'L014', '$.acceptance', '未声明验收条件，这条链的「好」无法被判定');
  }
  if (!chain.intent) add('warn', 'L015', '$.intent', '未声明 intent，其他链/模型无法判断何时该复用它');

  /* ---------------- F. 验收门五维评估 ---------------- */
  function assessGates() {
    const gates = {};

    // F1. 功能门：链是否有评审/测试/断言机制验证最终产出
    const hasCritic = nodes.some((n) => n.role === 'critic' || n.kind === 'gate');
    const hasTester = nodes.some((n) => n.role === 'test-executor' || n.role === 'test-designer');
    const hasAssert = nodes.some((n) => n.kind === 'fn' && n.use === 'assert');
    const hasOutputValidator = nodes.some((n) => n.kind === 'fn' && /validate|check|verify/i.test(n.use || ''));
    gates.functional = {
      passed: hasCritic || hasTester || hasAssert || hasOutputValidator,
      score: (hasCritic ? 0.4 : 0) + (hasTester ? 0.4 : 0) + (hasAssert || hasOutputValidator ? 0.2 : 0),
      evidence: {
        hasCritic, hasTester, hasAssert, hasOutputValidator,
        note: hasCritic || hasTester || hasAssert || hasOutputValidator ? '已配置产出验证机制' : '链缺少 review/test/assert 等验证节点，最终产出仅由 AI 自述裁定',
      },
    };
    if (!gates.functional.passed) {
      add('warn', 'G001', '$', '功能门未通过：链没有 critic/test-executor/assert 等独立验证节点，建议补充', '在 deliver 前增加 review + revise 回路或 test-executor 节点');
    }

    // F2. 静态门：结构/可达/终止/环路/数据流检查（即现有 lint error 集合）
    const errCount = findings.filter((f) => f.level === 'error').length;
    const warnCount = findings.filter((f) => f.level === 'warn').length;
    gates.static = {
      passed: errCount === 0,
      score: errCount === 0 ? 1 : Math.max(0, 1 - errCount * 0.2),
      evidence: { errors: errCount, warnings: warnCount },
    };

    // F3. 性能门：预算与规模是否匹配
    const b = chain.budget || {};
    const perfIssues = [];
    if (b.maxLlmCalls != null && b.maxLlmCalls < llmCount) perfIssues.push('maxLlmCalls 小于 llm 节点数');
    if (b.maxSteps != null && b.maxSteps < nodes.length * 2) perfIssues.push('maxSteps 可能不足');
    // 节点数上限默认 30。长篇/多分支链（如 longForm 双路径）确实需要更多节点，
    // 允许链头用 budget.maxNodes 显式放宽 —— 但放宽必须留痕（下方 info），
    // 避免「自己给自己开绿灯」而裁决层看不到。
    const DEFAULT_MAX_NODES = 30;
    const maxNodes = Number(b.maxNodes) > 0 ? Number(b.maxNodes) : DEFAULT_MAX_NODES;
    if (nodes.length > maxNodes) perfIssues.push(`节点数 ${nodes.length} 超过上限 ${maxNodes}，建议拆分或合并`);
    if (maxNodes !== DEFAULT_MAX_NODES) {
      add('info', 'G003', '$.budget',
        `节点数上限被链头显式放宽为 ${maxNodes}（默认 ${DEFAULT_MAX_NODES}），当前 ${nodes.length} 节点`,
        '放宽需有理由（如长篇双路径）；若无必要请回落默认值');
    }
    gates.performance = {
      passed: perfIssues.length === 0,
      score: perfIssues.length === 0 ? 1 : Math.max(0, 1 - perfIssues.length * 0.25),
      evidence: { issues: perfIssues, nodes: nodes.length, llmNodes: llmCount, budget: b },
    };
    if (perfIssues.length) {
      add('warn', 'G003', '$.budget', `性能门未通过：${perfIssues.join('；')}`, '调整 budget 或拆分链');
    }

    // F4. 安全门：扫描 prompt/输入中是否暴露敏感路径、密钥、绝对路径
    const sensitivePatterns = [
      { re: /(sk-[a-zA-Z0-9]{20,}|[A-Za-z0-9_]{20,}_[A-Za-z0-9_]{20,})/, name: '疑似 API Key' },
      /* 0.1.0 收紧：原版 `[A-Za-z]:\\[^\s"]+|\\[A-Za-z0-9_.-]+\\[^\s"]+` 把 redlines.regex 这种
         `\b\d{17}[\dXx]\b|1[3-9]\d{9}` 机器可读字符串误判成 Windows 路径（详见 .workbuddy/memory/MEMORY.md）。
         新版要求形如 `[A-Za-z]:\...` (盘符) 或典型 Windows 段 `\Users\` `\Windows\` `\Program Files\` `\AppData\` `\ProgramData\` `\Temp\`，
         或 POSIX 段 `/etc/` `/usr/` `/var/` `/bin/` `/tmp/` `/opt/` `/home/`。
         回滚：把下面 re 替换为上方 ORIGINAL。
         ORIGINAL: /[A-Za-z]:\\[^\s"]+|\\[A-Za-z0-9_.-]+\\[^\s"]+/
      */
      { re: /[A-Za-z]:\\[^"\s]+|\\(?:Users|Windows|Program Files|AppData|ProgramData|Temp)\\[^"\s]+|\/(?:etc|usr|var|bin|tmp|opt|home)\/[^"\s]+/, name: 'Windows 绝对路径' },
      { re: /(password|secret|token|private_key)\s*[:=]\s*[^\s"]+/i, name: '敏感配置项' },
    ];
    const secHits = [];
    const seenSamples = new Set();
    // 安全门取值：只扫「链作者写的内容」，跳过引擎/注册表注入的内部字段。
    //
    // 修复背景（2026-09-01，G004 误报）：registry.js 加载链时会注入 `_file`（链的**绝对磁盘路径**），
    // 而本函数原本用 Object.values() 全量递归，导致在 Windows 盘符目录下（如 D:\...）运行时，
    // **任何链都必然命中「Windows 绝对路径」** → 安全门恒 passed=false → 所有链 lint 都判"未通过"。
    // 已验证 gen.generic-pipeline / gen.chain-governance / gen.dev-knowledge 均受影响，属全局误报。
    //
    // 约定：`_` 前缀字段为引擎内部元信息（_file / _diagnostics / _meta 等），不属链定义，不参与敏感扫描。
    // 链作者手写的密钥、绝对路径、敏感配置**仍然会被检出**（它们不会以 `_` 开头）。
    function collectStrings(v) {
      if (typeof v === 'string') return [v];
      if (Array.isArray(v)) return v.flatMap(collectStrings);
      if (v && typeof v === 'object') {
        return Object.entries(v)
          .filter(([key]) => !key.startsWith('_'))
          .flatMap(([, val]) => collectStrings(val));
      }
      return [];
    }
    const allStrings = collectStrings(chain);
    for (const p of sensitivePatterns) {
      for (const s of allStrings) {
        const m = s.match(p.re);
        if (!m) continue;
        const sample = m[0].slice(0, 60);
        if (seenSamples.has(sample)) continue;
        seenSamples.add(sample);
        secHits.push({ pattern: p.name, sample });
        break; // 每个 pattern 只报一次
      }
    }
    gates.security = {
      passed: secHits.length === 0,
      score: secHits.length === 0 ? 1 : Math.max(0, 1 - secHits.length * 0.3),
      evidence: { hits: secHits },
    };
    if (secHits.length) {
      add('warn', 'G004', '$', `安全门发现 ${secHits.length} 处潜在敏感信息暴露`, '将密钥/绝对路径改为环境变量或配置注入');
    }

    // F5. 回归门：链是否声明回归测试或保留 golden output 对比能力
    const hasRegressionTests = nodes.some((n) =>
      (n.role === 'test-executor') ||
      (n.kind === 'fn' && /regression|golden|diff/i.test(n.use || '')) ||
      JSON.stringify(chain).includes('regression')
    );
    const hasVersion = /^v?\d+\.\d+\.\d+/.test(chain.version || '');
    gates.regression = {
      passed: hasRegressionTests && hasVersion,
      score: (hasRegressionTests ? 0.7 : 0) + (hasVersion ? 0.3 : 0),
      evidence: { hasRegressionTests, hasVersion, version: chain.version },
    };
    if (!gates.regression.passed) {
      add('info', 'G005', '$', `回归门：${hasRegressionTests ? '已声明测试' : '未声明回归测试'}，${hasVersion ? '已设版本号' : '未设版本号'}`, '链增加 regressionTests 字段或保留 golden 输出');
    }

    return gates;
  }

  const gates = assessGates();

  /* ---------------- G. 治理门（「带 AI 打仗」四层治理）---------------- */
  // 放在 assessGates 之后追加，避免治理缺口把「静态门」也一起拖挂——
  // 静态门查的是链能不能跑，治理门查的是这条链值不值得被信任，两件事不能混。
  let governance = null;
  if (opts.governance !== false) {
    governance = evaluateGovernance(chain);
    for (const f of governance.findings) findings.push(f);
    gates.governance = {
      passed: governance.passed,
      score: governance.score,
      evidence: {
        tier: governance.tier,
        tierInferred: governance.tierInferred,
        byLayer: governance.byLayer,
        hit: `${governance.summary.hit}/${governance.summary.total}`,
        note: governance.passed
          ? `四层治理达标（${governance.tier} 链，覆盖 ${(governance.score * 100).toFixed(0)}%）`
          : `四层治理缺 ${governance.summary.errors} 项硬要求（${governance.tier} 链）`,
      },
    };
  }

  const hardGatesPassed = ['functional', 'static', 'performance', 'security'].every((g) => gates[g].passed);

  /* ---------------- 汇总 ---------------- */
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  const infos = findings.filter((f) => f.level === 'info');
  const score = Math.max(0, +(1 - errors.length * 0.2 - warns.length * 0.05).toFixed(3));

  return {
    ok: errors.length === 0 && hardGatesPassed,
    score,
    findings,
    gates,
    ...(governance ? { governance } : {}),
    summary: {
      nodes: nodes.length,
      llmNodes: llmCount,
      reachable: reached.size,
      orphans: nodes.length - reached.size,
      terminators: terminators.length,
      cycles: seenCycle.size,
      errors: errors.length,
      warnings: warns.length,
      infos: infos.length,
      ...(governance ? { tier: governance.tier, governanceScore: governance.score } : {}),
    },
    graph: { edges: wakeEdges, reached: [...reached] },
  };
}

function formatFindings(res) {
  const icon = { error: '✖', warn: '▲', info: '·' };
  const lines = [];
  if (res.gates) {
    lines.push('  验收门评估：');
    for (const g of GATES) {
      const gate = res.gates[g];
      if (!gate) continue;
      const mark = gate.passed ? '✓' : (g === 'regression' ? '·' : '▲');
      lines.push(`    ${mark} ${g.padEnd(12)} ${(gate.score * 100).toFixed(0).padStart(3)}%  ${gate.evidence.note || ''}`);
    }
    if (res.governance) {
      const gv = res.governance;
      const layers = Object.entries(gv.byLayer)
        .map(([k, v]) => `${k} ${(v.rate * 100).toFixed(0)}%`)
        .join('  ');
      lines.push(`      四层治理｜${layers}${gv.tierInferred ? `（等级 ${gv.tier} 为推断值，可用 $.tier 显式声明）` : ''}`);
    }
    lines.push('');
  }
  if (!res.findings.length) {
    lines.push('  （无发现）');
    return lines.join('\n');
  }
  lines.push(...res.findings
    .sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.level] - { error: 0, warn: 1, info: 2 }[b.level]))
    .map((f) => `  ${icon[f.level]} [${f.rule}] ${f.where}\n      ${f.msg}${f.fix ? `\n      → 建议：${f.fix}` : ''}`));
  return lines.join('\n');
}

module.exports = { lint, formatFindings, declaredSignals, FN_SIGNALS };
