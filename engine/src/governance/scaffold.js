'use strict';
/**
 * scaffold.js —— 蓝图 → 链定义 的确定性编译器
 *
 * 这是元系统的核心。它保证：
 *   1. 无论蓝图多残缺，都能编译出一条**结构合法、可达、可终止**的链；
 *   2. 骨架部分（触发器接线、intake、终止节点、迭代回路刹车）由代码生成，
 *      模型不参与——因为这些正是模型最容易写错、错了又最致命的地方；
 *   3. 模型只贡献「阶段序列与角色」这一层语义判断。
 *
 * 编译产物的固定骨架：
 *
 *   chain.start
 *        │
 *     [intake] ──intake.invalid──> [bail] (halt)
 *        │ intake.ready
 *     [stage1] ─signal─> [stage2] ─signal─> ... ─> [stageN]
 *                                                     │
 *                              ┌──────────────────────┘  (qualityGate 开启时)
 *                              ↓
 *                          [review] ──> [qualityGate]
 *                                          │  fail → [revise] ──┐
 *                                          │                    │ (maxRuns 刹车)
 *                                          │  pass              ↓
 *                                          ↓                 [review]
 *                                      [deliver] → chain.end
 */

const { buildPrompt, ROLES } = require('./templates');
const { applyGovernanceBaseline } = require('./baseline');

const slug = (s, fallback) => {
  const t = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return t || fallback;
};

const ident = (s, i) => {
  const t = String(s || '').trim().replace(/[^a-zA-Z0-9_]/g, '');
  return /^[a-zA-Z_]/.test(t) ? t : `stage${i + 1}`;
};

/**
 * 复用模板：生成「早退门 / 短路」网关节点（kind:"gate"）。
 * 确定性分支：cases 按 when 顺序求值，命中即发 emit。某分支可声明 bail:true，
 * 配合节点级 shortCircuit:true 时，命中该分支会令整链立即终止（与 node.halt 语义一致）。
 * 不短路的分支仅通过 emit 信号做下游路由（失败→后续贵节点不订阅→自然跳过）。
 *
 * 这是 C「早退门/短路」任务落地的可复用原语：任何链都能用 genGate 声明一道门，
 * 而不必手写 gate JSON。
 */
function genGate({ id, title, triggerOn, cases = [], def = 'gate.nomatch', out, shortCircuit = false, bailOnDefault = false, declares }) {
  const node = {
    id,
    kind: 'gate',
    title: title || id,
    trigger: [{ on: triggerOn }],
    cases: cases.map((c) => ({
      when: c.when,
      emit: c.emit,
      label: c.label || (Array.isArray(c.emit) ? c.emit[0] : c.emit),
      reason: c.reason || '',
      ...(c.bail ? { bail: true } : {}),
    })),
    default: def,
    declares: declares || [...new Set([...cases.flatMap((c) => (Array.isArray(c.emit) ? c.emit : [c.emit])).filter(Boolean), def].filter(Boolean))],
  };
  if (out) node.out = out;
  if (shortCircuit) { node.shortCircuit = true; if (bailOnDefault) node.bailOnDefault = true; }
  return node;
}

/**
 * @param {object} blueprint  chain-architect 的输出
 * @param {object} opts { chainId, defaults }
 * @returns {{chain: object, notes: string[]}}
 */
function scaffold(blueprint = {}, opts = {}) {
  const notes = [];
  const bp = blueprint || {};

  /* ---------- 1. 链头信息 ---------- */
  let chainId = opts.chainId || bp.chainId;
  if (!chainId || !/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(chainId)) {
    const guess = `gen.${slug(bp.title || bp.intent || 'chain', 'unnamed')}`.slice(0, 48);
    notes.push(`蓝图未提供合法 chainId（原值 ${JSON.stringify(chainId)}），已自动生成 "${guess}"`);
    chainId = guess;
  }

  const chainHead = {
    id: chainId,
    title: bp.title || '未命名链',
    version: '0.0.1',
    intent: bp.intent || bp.title || '（未声明意图）',
    principle: (() => {
      const base = Array.isArray(bp.principle) && bp.principle.length ? bp.principle : [
        '每个节点只做一件事，且这件事的产出必须可被校验。',
        '证据不足时返回 null 并报 issue，绝不臆造。',
        '发现输入冲突时显式报告，不自行折中。',
      ];
      const FB = '每个节点执行后必须产生可观测的逐步反馈（通过信号与追踪器暴露本步的操作与产出），整条链的运行过程可被逐步复盘，不能是黑箱。';
      return base.includes(FB) ? base : [...base, FB];
    })(),
    acceptance: (() => {
      const base = Array.isArray(bp.acceptance) && bp.acceptance.length ? bp.acceptance : [
        '产出符合各节点声明的输出契约',
        '链能在预算内自然终止而非被熔断',
      ];
      const FB = '运行过程每一步都可被追踪与反馈，而非黑箱执行。';
      return base.includes(FB) ? base : [...base, FB];
    })(),
    budget: {
      maxSteps: 200,
      maxLlmCalls: 40,
      maxTokens: 200000,
      maxWallMs: 180000,
      maxNodeRuns: 8,
      ...(bp.budget || {}),
    },
    nodes: [],
  };

  /* ---------- 2. 阶段归一化 ---------- */
  let stages = Array.isArray(bp.stages) ? bp.stages.filter((s) => s && (s.id || s.role)) : [];
  if (!stages.length) {
    notes.push('蓝图没有任何 stages，已回退到默认三段式骨架（理解 → 产出 → 校验）');
    stages = [
      { id: 'understand', role: 'schema-inducer', intent: '把目标拆成可判定的结构与验收条件' },
      { id: 'produce', role: 'generator', intent: '按结构产出主体结果' },
      { id: 'verify', role: 'critic', intent: '对照验收条件逐项检查' },
    ];
  }
  if (stages.length > 12) {
    notes.push(`蓝图给了 ${stages.length} 个阶段，超过上限 12，已截断。阶段过多通常意味着分解粒度过细`);
    stages = stages.slice(0, 12);
  }

  const seen = new Set();
  stages = stages.map((s, i) => {
    let id = ident(s.id || s.role, i);
    while (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    const role = ROLES[s.role] ? s.role : 'generic';
    if (!ROLES[s.role]) notes.push(`阶段 ${id} 的角色 "${s.role}" 不在模板库中，已降级为 generic 模板`);
    return {
      id,
      role,
      title: s.title || s.intent || id,
      intent: s.intent || s.title || `执行 ${role} 职责`,
      kind: s.kind === 'fn' ? 'fn' : 'llm',
      use: s.use,
    };
  });

  /* ---------- 3. intake：统一入口 ---------- */
  chainHead.nodes.push({
    id: 'intake',
    kind: 'fn',
    title: '入口归一化',
    use: 'intake',
    trigger: [{ on: 'chain.start' }],
    in: { raw: '$.input' },
    out: '$.intake',
    declares: ['intake.ready', 'intake.invalid'],
  });

  chainHead.nodes.push({
    id: 'bail',
    kind: 'fn',
    title: '入参非法，提前终止',
    use: 'deliver',
    trigger: [{ on: 'signal.intake.invalid' }],
    in: { answer: null, quality: { aborted: true, reason: '输入缺少可执行目标' } },
    out: '$.output',
    halt: true,
    declares: ['chain.end'],
  });

  /* ---------- 4. 主干阶段串联 ---------- */
  const upstreamOf = (i) => (i === 0
    ? [{ id: 'intake', path: '$.intake', title: '归一化后的输入' }]
    : [{ id: stages[i - 1].id, path: `$.${stages[i - 1].id}`, title: stages[i - 1].title }]);

  stages.forEach((st, i) => {
    const prevSignal = i === 0 ? 'signal.intake.ready' : `signal.${stages[i - 1].id}.done`;
    const outSignal = `${st.id}.done`;

    if (st.kind === 'fn') {
      chainHead.nodes.push({
        id: st.id,
        kind: 'fn',
        title: st.title,
        use: st.use || 'noop',
        trigger: [{ on: prevSignal }],
        in: { sources: [`$.${i === 0 ? 'intake' : stages[i - 1].id}`] },
        out: `$.${st.id}`,
        emit: [outSignal],
        declares: [outSignal],
      });
      return;
    }

    const p = buildPrompt({
      role: st.role,
      chain: chainHead,
      stage: st,
      upstream: upstreamOf(i),
      signals: [outSignal],
    });

    chainHead.nodes.push({
      id: st.id,
      kind: 'llm',
      title: st.title,
      role: st.role,
      trigger: [{ on: prevSignal }],
      prompt: { system: p.system, user: p.user },
      expect: p.expect,
      temperature: p.temperature,
      retry: { max: 2, onExhausted: 'throw' },
      out: `$.${st.id}`,
      emit: [outSignal],
      declares: [outSignal],
      maxRuns: 6,
    });
  });

  const lastStage = stages[stages.length - 1];
  let deliverTrigger = `signal.${lastStage.id}.done`;

  /* ---------- 5. 质量门 + 迭代回路（可选） ---------- */
  const wantGate = bp.qualityGate !== false;
  const iter = bp.iterate || {};
  const maxRounds = Math.max(1, Math.min(5, Number(iter.maxRounds) || 2));
  const target = Number(iter.target) || 0.85;

  if (wantGate) {
    // 修订产物写到独立路径（$.revised）而不是覆盖原阶段输出。
    // 直接覆盖会造成类型污染：patcher 的 {patched,applied,rejected} 结构
    // 和被覆盖阶段的输出契约通常完全不同型，下游再按原契约取值就会拿到错的东西。
    // 写 $.revised 后，干净修订结果自然落在 $.revised.patched，下游用 coalesce 取它。
    const currentAnswer = `coalesce($.revised.patched, $.${lastStage.id})`;

    const reviewPrompt = buildPrompt({
      role: 'critic',
      chain: chainHead,
      stage: { intent: '对照验收条件严格评审最终产出，给出 0-1 分与具体缺陷' },
      upstream: [{ id: lastStage.id, path: currentAnswer, title: '待评审产出（若已修订则为修订版）' }],
      signals: ['review.done'],
    });

    chainHead.nodes.push({
      id: 'review',
      kind: 'llm',
      title: '质量评审',
      role: 'critic',
      trigger: [{ on: `signal.${lastStage.id}.done` }, { on: 'signal.revise.done' }],
      prompt: { system: reviewPrompt.system, user: reviewPrompt.user },
      expect: reviewPrompt.expect,
      temperature: 0.1,
      retry: { max: 2, onExhausted: 'passthrough' },
      out: '$.review',
      appendTo: '$.reviewHistory',
      emit: ['review.done'],
      declares: ['review.done'],
      maxRuns: maxRounds + 1,
    });

    chainHead.nodes.push(genGate({
      id: 'qualityGate',
      title: '质量闸门',
      triggerOn: 'signal.review.done',
      cases: [
        { when: `$.review.score >= ${target}`, emit: 'quality.pass', label: '达标', reason: `评分达到目标 ${target}` },
        { when: `len($.reviewHistory) >= ${maxRounds}`, emit: 'quality.exhausted', label: '轮次耗尽', reason: `已迭代 ${maxRounds} 轮，收益递减，强制收敛` },
        { when: 'empty($.review.weaknesses)', emit: 'quality.pass', label: '无缺陷', reason: '评审未发现缺陷' },
      ],
      def: 'quality.fail',
    }));

    const revisePrompt = buildPrompt({
      role: 'patcher',
      chain: chainHead,
      stage: { intent: '逐条修复评审指出的缺陷。不同意的要放进 rejected 并说明理由' },
      upstream: [
        { id: lastStage.id, path: `$.${lastStage.id}`, title: '原产出' },
        { id: 'review', path: '$.review', title: '评审意见' },
      ],
      signals: ['revise.done'],
    });

    chainHead.nodes.push({
      id: 'revise',
      kind: 'llm',
      title: '定向修订',
      role: 'patcher',
      trigger: [{ on: 'signal.quality.fail' }],
      prompt: { system: revisePrompt.system, user: revisePrompt.user },
      expect: revisePrompt.expect,
      temperature: 0.2,
      retry: { max: 1, onExhausted: 'passthrough' },
      out: '$.revised',
      emit: ['revise.done'],
      declares: ['revise.done'],
      maxRuns: maxRounds,
    });

    deliverTrigger = 'signal.quality.pass';
  }

  /* ---------- 6. 终止节点 ---------- */
  const deliverTriggers = [{ on: deliverTrigger }];
  if (wantGate) deliverTriggers.push({ on: 'signal.quality.exhausted' });

  chainHead.nodes.push({
    id: 'deliver',
    kind: 'fn',
    title: '收敛交付',
    use: 'deliver',
    trigger: deliverTriggers,
    in: {
      answer: `=coalesce($.revised.patched, $.${lastStage.id})`,
      artifacts: Object.fromEntries(stages.map((s) => [s.id, `$.${s.id}`])),
      quality: wantGate ? '$.review' : { note: '未启用质量门' },
    },
    out: '$.output',
    halt: true,
    declares: ['deliver.done', 'chain.end'],
  });

  /* ---------- 7. 四层治理基线注入 ---------- *
   * 放在最后而不是边生成边加，是因为基线注入器需要看到完整拓扑
   * 才能判断该往哪里挂护栏、哪些产物要进证据包。
   *
   * 这一步不是锦上添花：治理门已进 lint 第六门，新链若不带基线，
   * sys.genesis 的 genesis.lint 必挂 → 触发 lint.fail → repair 空转，
   * 元系统会陷入「自己造的链自己修不好」的死循环。
   */
  if (bp.governance === false) {
    notes.push('蓝图显式声明 governance:false，已跳过四层治理基线注入——该链将无法通过治理门，仅适用于一次性内部工具');
    return { chain: chainHead, notes };
  }

  const gov = applyGovernanceBaseline(chainHead, {
    tier: bp.tier,
    boundaries: bp.boundaries,
    boundaryKeywords: bp.boundaryKeywords,
    extraRules: bp.redlineRules,
    highRiskActions: bp.highRiskActions,
    clarify: bp.clarify !== false,
    scope: bp.intent || bp.title,
  });

  for (const a of gov.added) notes.push(`[治理·${a.layer}] ${a.key}：${a.what}`);
  for (const r of gov.rewires) notes.push(`[治理·接线] ${r.node}：${r.from} → ${r.to}（${r.why}）`);
  for (const m of gov.manual) notes.push(`[治理·待人补] ${m.key}：${m.what}`);
  notes.push(`[治理] 覆盖度 ${(gov.before.score * 100).toFixed(0)}% → ${(gov.after.score * 100).toFixed(0)}%，等级 ${gov.after.tier}，硬门${gov.after.passed ? '通过' : `未过（${gov.after.summary.errors} 项 error）`}`);

  return { chain: gov.chain, notes };
}

/* ------------------------------------------------------------------ *
 *  补丁应用：chain-fixer 的输出 → 修改后的链
 * ------------------------------------------------------------------ */
function applyPatches(chain, patches) {
  const out = JSON.parse(JSON.stringify(chain));
  const applied = [];
  const failed = [];

  const resolve = (root, path) => {
    // 支持 nodes.<id>.field 与 $.field 两种寻址
    const raw = String(path).replace(/^\$\.?/, '');
    const parts = raw.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = root, parent = null, key = null;
    for (let i = 0; i < parts.length; i++) {
      let k = parts[i];
      if (Array.isArray(cur) && !/^\d+$/.test(k)) {
        const idx = cur.findIndex((x) => x && x.id === k);
        if (idx < 0) return { parent: cur, key: null, missing: k };
        k = String(idx);
      }
      parent = cur; key = k;
      if (i < parts.length - 1) {
        if (cur[k] === undefined || cur[k] === null) cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        cur = cur[k];
      }
    }
    return { parent, key };
  };

  for (const p of patches || []) {
    try {
      const { parent, key, missing } = resolve(out, p.path);
      if (missing) { failed.push({ ...p, error: `路径中找不到节点 "${missing}"` }); continue; }
      if (p.op === 'set') parent[key] = p.value;
      else if (p.op === 'merge') parent[key] = { ...(parent[key] || {}), ...(p.value || {}) };
      else if (p.op === 'push') {
        if (!Array.isArray(parent[key])) parent[key] = parent[key] == null ? [] : [parent[key]];
        parent[key].push(p.value);
      } else if (p.op === 'remove') {
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
      } else { failed.push({ ...p, error: `未知操作 ${p.op}` }); continue; }
      applied.push({ op: p.op, path: p.path, rule: p.rule, reason: p.reason });
    } catch (e) {
      failed.push({ ...p, error: e.message });
    }
  }
  return { chain: out, applied, failed };
}

module.exports = { scaffold, applyPatches, slug, genGate };
