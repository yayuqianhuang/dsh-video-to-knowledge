'use strict';
/**
 * baseline.js —— 「带 AI 打仗」四层治理基线注入器（唯一实现）
 *
 * 为什么要有这个文件：
 *   governance.js 只回答「这条链缺什么」，它是尺子；
 *   baseline.js 回答「缺的怎么补」，它是模具。
 *   两者共用同一套 GV 维度，标准不会漂移——尺子量出来的缺口，
 *   模具补完之后必须能过尺子，这是本文件的回归判据。
 *
 * 谁在用它：
 *   1. scaffold.js —— sys.genesis 新建链时自动注入，保证新链出生即达标；
 *      （否则 genesis.lint 治理门必挂 → 触发 lint.fail → repair 回路空转）
 *   2. scripts/retrofit-governance.js —— 给存量链批量补齐。
 *
 * 注入原则（对存量链尤其重要）：
 *   · 只加不改：已存在的字段/节点一律不覆盖，只做「补齐到门槛」；
 *   · 接线改动最小化：为了插入护栏，必须且仅需改写「原本订阅 intake.ready 的节点」
 *     和「deliver 的触发信号」这两处，每一处都会记进 rewires 明细供人过目；
 *   · 幂等：同一条链重复注入，第二次的 added 应为空。
 *
 * 注入后的骨架（方括号为本文件负责补齐的部分）：
 *
 *   chain.start → intake ──intake.invalid──┐
 *                    │ intake.ready        │
 *                [clarify] ──clarify.block─┤
 *                    │ clarify.done        ├─→ [bail] (halt)
 *               [redlines] ──redlines.fail─┘
 *                    │ redlines.pass
 *                 原有阶段 … → review → qualityGate → revise
 *                    │ quality.pass / quality.exhausted
 *               [evidence] → [assert] → deliver(completionPackage) (halt)
 */

const { evaluate } = require('./governance');

/* ------------------------------------------------------------------ *
 *  战略层素材：人定的东西，AI 不得改写，这里只提供「缺省底线」
 * ------------------------------------------------------------------ */

/** 补足 principle 到 5 条时使用，按重要性排序，取前 N 条补齐 */
const GOV_PRINCIPLES = [
  '战略层（意图 / 原则 / 验收 / 红线 / 边界）由人设定，AI 只能执行与追问，不得自行改写或降低标准。',
  '触碰红线，或意图模糊却指向高危动作（删除 / 重写 / 迁移 / 资金 / 越权）时，必须停下来交回人裁定，不得单方推进。',
  '证据不足时返回 null 并报 issue，绝不臆造；每条结论都要能指回具体产物或统计。',
  '交付是否合格由机器门判定（lint / assert / 回归），不接受 AI 自证。',
  '每步产出可观测、可复盘，整条链不得是黑箱。',
];

/** 补足 acceptance 到 5 条时使用 */
const GOV_ACCEPTANCE = [
  '产出符合各节点声明的输出契约（expect），无契约违例。',
  '链在预算内自然终止（走到 halt 节点），而非被熔断或耗尽预算。',
  '红线门通过（$.redlines.passed == true），无 critical 违规。',
  '完成包 completionPackage 字段齐全，且叙述层与证据层分离标注。',
  '证据包含可重跑命令与产物 Hash，结论可被第三方独立复核。',
];

/** 顶层 redlines：与 fn:redlines 的五条硬检查一一对应，人读的版本 */
const GOV_REDLINES = [
  'AI 不得单方定义或降低成功标准',
  'AI 不得伪造证据、编造数据或结果',
  '不得跳过任何验收门（review / assert / 回归）',
  '不得越出本链声明的作战边界，侵入不归本链管辖的系统或数据',
  '不得删除或覆盖运行证据与追踪记录',
];

const GOV_NEXT_STEPS = [
  '按 review 指出的 weaknesses 逐条修复后重跑',
  '若本次有未完成项（openItems），先补足再进入下一阶段',
  '用 gen.chain-governance 定期审查本链治理覆盖度',
];

/* ------------------------------------------------------------------ *
 *  小工具
 * ------------------------------------------------------------------ */

const A = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const clone = (x) => JSON.parse(JSON.stringify(x));
const NODES = (c) => (Array.isArray(c.nodes) ? c.nodes : []);
const byId = (c, id) => NODES(c).find((n) => n.id === id);
const like = (c, re) =>
  NODES(c).find((n) => re.test(n.id || '') || re.test(n.use || '') || re.test(n.title || '') || re.test(n.role || ''));
const trigsOn = (n, sig) => A(n.trigger).some((t) => t && t.on === sig);

/** 在 nodes 数组中，把 node 插到 anchorId 之后（找不到锚点就追加到末尾） */
function insertAfter(c, anchorId, node) {
  const i = NODES(c).findIndex((n) => n.id === anchorId);
  if (i < 0) c.nodes.push(node);
  else c.nodes.splice(i + 1, 0, node);
}

/** 在 nodes 数组中，把 node 插到 beforeId 之前 */
function insertBefore(c, beforeId, node) {
  const i = NODES(c).findIndex((n) => n.id === beforeId);
  if (i < 0) c.nodes.push(node);
  else c.nodes.splice(i, 0, node);
}

/** 数组去重补齐到 min 条：已有的一律保留，只从 pool 里取没有的往后加 */
function topUp(existing, pool, min) {
  const out = A(existing).slice();
  const has = (s) => out.some((x) => String(x).trim() === String(s).trim());
  for (const p of pool) {
    if (out.length >= min) break;
    if (!has(p)) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  节点模具
 * ------------------------------------------------------------------ */

/**
 * clarify 意图护栏（GV014）。
 * 这是四层治理里唯一「AI 主动往回踢」的节点：它不产出业务结果，
 * 只判断「用户这句话是不是在让我干一件不可逆的大事」，是就交回人。
 *
 * 注意 emit 强制 clarify.done：这是防呆闸——模型忘了发信号会让整条链停在这里，
 * 空耗预算比误放行更难排查。真正的拦截靠 clarify.block → bail(halt) 收口。
 */
function clarifyNode(c, opts) {
  const highRisk = A(opts.highRiskActions).length
    ? A(opts.highRiskActions)
    : ['删除 / 删库 / 清空数据', '推倒重写 / 从零重做 / 废弃现有实现', '数据迁移 / 不可逆变更', '资金 / 支付 / 对外承诺', '越权访问不属于本链边界的系统'];

  const boundaryHint = opts.boundaryHint || '本链声明的 $.boundaries';

  const system = [
    '你是一条 AI JSON 触发链上的执行单元（intent-guard / 防误解护栏）。',
    '只输出一个 JSON 对象。不要代码围栏，不要解释，不要寒暄。',
    '输出必须是统一信封格式：{"meta":{},"data":{},"signals":[],"issues":[]}。',
    '',
    '【你的职责】在链进入实质执行之前，澄清用户的真实意图，拦截「AI 单方执行不可逆高危动作」的风险。',
    '你不制定计划、不产出业务结果、不替人做战略决策。',
    '',
    '【高危意图清单】用户目标或约束中出现以下任一指向时，视为待澄清：',
    ...highRisk.map((s) => `- ${s}`),
    '',
    '【三种判别】',
    '(A) 目标明确且不触及高危动作 → 直接放行。',
    '(A2) 触及高危措辞，但用户已明确声明「保留现有 / 不删 / 存量不动 / 平行新增」等可逆口径 → 放行，并在 note 中记录已确认的可逆口径。',
    '(B) 明确指向不可逆高危动作（真删除 / 真重写 / 真迁移 / 真付款），且没有人给出显式授权 → 拦截。',
    '',
    '【你的动作】',
    '- (A) / (A2) → emit "clarify.done"，data.verdict 写 "pass"，data.note 说明判别依据。',
    '- (B) → emit "clarify.block"，data.verdict 写 "block"；data.note 写明：该意图属不可逆高危动作，依「带 AI 打仗」四层治理须上交战略层（人）裁定，',
    `  并要求人在 boundaries / constraints 中显式授权（override）后方可继续。AI 不得单方决定执行。边界依据：${boundaryHint}。`,
    '',
    '【判定尺度】措辞模糊时优先放行并在 note 标注「待人确认口径」；只有表述明确指向 (B) 才拦截。宁可多问一句，不可少拦一次。',
  ].join('\n');

  // 入口路径按链而定：有 intake 的读 $.intake.*，没有的读原始输入
  const ip = opts.inputPath || '$.intake';
  const user = [
    '【用户原始目标】',
    `{{${ip}.goal}}`,
    '',
    '【原始输入】',
    '{{$.input}}',
    '',
    '【人定成功标准】',
    `{{${ip}.successCriteria}}`,
    '',
    '【人定禁区】',
    `{{${ip}.boundaries}}`,
    '',
    '【人定约束】',
    `{{${ip}.constraints}}`,
    '',
    '判断上述输入属于 (A) 安全 / (A2) 高危措辞但口径可逆 / (B) 不可逆高危动作 中的哪一种。',
    '按判别结果在 signals 中 emit 对应信号（clarify.done 或 clarify.block），并在 data 中给出 verdict / intent / note。',
  ].join('\n');

  return {
    id: 'clarify',
    kind: 'llm',
    title: '防误解护栏（高危意图澄清 · 不可逆动作交回人裁定）',
    role: 'intent-guard',
    trigger: [{ on: opts.entryReady }],
    prompt: { system, user },
    expect: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        intent: { type: 'string' },
        note: { type: 'string' },
      },
    },
    temperature: 0.1,
    retry: { max: 1, onExhausted: 'throw' },
    out: '$.clarify',
    emit: ['clarify.done'],
    declares: ['clarify.done', 'clarify.block'],
    maxRuns: 2,
  };
}

/** redlines 硬拦截门（GV004）。fn 实现在 engine/functions.js，参数可按链定制。 */
function redlinesNode(opts) {
  const node = {
    id: 'redlines',
    kind: 'fn',
    title: '红线门：禁止 AI 越权 / 伪造 / 跳门 / 越界 / 丢证据',
    use: 'redlines',
    trigger: [{ on: 'signal.clarify.done' }],
    out: '$.redlines',
    declares: ['redlines.pass', 'redlines.fail'],
    maxRuns: 2,
  };
  const inArgs = {};
  if (A(opts.boundaryKeywords).length) inArgs.boundaryKeywords = A(opts.boundaryKeywords);
  if (A(opts.extraRules).length) inArgs.extraRules = A(opts.extraRules);
  if (Object.keys(inArgs).length) node.in = inArgs;
  return node;
}

/** evidence 证据层军报（GV021）：机器出，不经模型的手 */
function evidenceNode(triggers, artifacts) {
  const node = {
    id: 'evidence',
    kind: 'fn',
    title: '证据层军报：归档原始产物 + Hash + 可重跑命令（机器出，不可编造）',
    use: 'evidence',
    trigger: triggers,
    out: '$.evidence',
    emit: ['evidence.done'],
    declares: ['evidence.done'],
  };
  if (artifacts && Object.keys(artifacts).length) node.in = { artifacts };
  return node;
}

/** assert 机器验证门（GV017）：交付前最后一道，不接受 AI 自证 */
function assertNode(conditions) {
  return {
    id: 'assert',
    kind: 'fn',
    title: '交付前独立断言（机器门，不接受 AI 自证）',
    use: 'assert',
    trigger: [{ on: 'signal.evidence.done' }],
    in: { conditions },
    out: '$.assert',
    declares: ['assert.passed', 'assert.failed'],
  };
}

/* ------------------------------------------------------------------ *
 *  主入口
 * ------------------------------------------------------------------ */

/**
 * 给一条链注入四层治理基线。
 *
 * @param {object} chain 链定义
 * @param {object} opts
 *   - tier             'combat' | 'utility'，不传则沿用/推断
 *   - boundaryKeywords fn:redlines 的边界关键词（如 ['example']）
 *   - extraRules       fn:redlines 的自定义红线
 *   - boundaries       自定义 $.boundaries，不传则生成缺省
 *   - highRiskActions  clarify 的高危动作清单
 *   - clarify          false 则跳过护栏注入（工具链可关）
 *   - scope            完成包 scope 文案
 * @returns {{chain, added, manual, rewires, before, after}}
 */
function applyGovernanceBaseline(chain, opts = {}) {
  const c = clone(chain);
  const added = [];
  const manual = [];
  const rewires = [];
  const before = evaluate(chain);

  const add = (layer, key, what) => added.push({ layer, key, what });
  const todo = (layer, key, what) => manual.push({ layer, key, what });

  /* ============ 战略层：人定目标 ============ */

  if (!c.tier) {
    c.tier = opts.tier || before.tier;
    add('战略层', 'tier', `显式声明链等级 tier="${c.tier}"（原为按规模推断，推断值会随节点数漂移）`);
  } else if (opts.tier && opts.tier !== c.tier) {
    c.tier = opts.tier;
    add('战略层', 'tier', `链等级改判为 "${opts.tier}"`);
  }

  if (!c.intent || String(c.intent).length < 20) {
    todo('战略层', 'GV001', 'intent 缺失或不足 20 字——这句话必须由人写，模具不代笔');
  }

  const p0 = A(c.principle).length;
  if (p0 < 5) {
    c.principle = topUp(c.principle, GOV_PRINCIPLES, 5);
    add('战略层', 'GV002', `principle ${p0} → ${c.principle.length} 条（补入治理缺省底线，原有条目未改动）`);
  }

  const a0 = A(c.acceptance).length;
  if (a0 < 5) {
    c.acceptance = topUp(c.acceptance, GOV_ACCEPTANCE, 5);
    add('战略层', 'GV003', `acceptance ${a0} → ${c.acceptance.length} 条`);
  }

  if (!A(c.redlines).length) {
    c.redlines = GOV_REDLINES.slice();
    add('战略层', 'GV004', `新增顶层 $.redlines（${GOV_REDLINES.length} 条），与 fn:redlines 的机器检查一一对应`);
  }

  if (!c.boundaries) {
    c.boundaries = opts.boundaries || {
      owns: c.intent || c.title || '本链声明的职责范围',
      notOwns: [
        '战略目标与验收标准的设定（属人，AI 只能执行与追问）',
        '超出本链 intent 声明范围的系统、代码与数据',
        '删除 / 迁移 / 资金 / 对外承诺等不可逆动作的最终决策',
      ],
      escalateTo: '战略层（人）—— 经 clarify 护栏发 clarify.block，由 bail 收口交回',
    };
    add('战略层', 'GV005', '新增 $.boundaries（owns / notOwns / escalateTo），明确「不归我管」的区域');
  }

  /* ============ 建制层：拓扑与契约 ============ */

  if (c.budget == null) {
    c.budget = { maxSteps: 200, maxLlmCalls: 40, maxTokens: 200000, maxWallMs: 180000, maxNodeRuns: 8 };
    add('建制层', 'GV006', '补 budget 默认预算');
  }

  const noExpect = NODES(c).filter((n) => n.kind === 'llm' && !(n.expect && Object.keys(n.expect).length));
  if (noExpect.length) {
    todo('建制层', 'GV007', `${noExpect.length} 个 llm 节点无 expect 契约（${noExpect.map((n) => n.id).join(', ')}）——契约要按语义写，模具不敢瞎补`);
  }

  const noTrigger = NODES(c).filter((n) => !A(n.trigger).length);
  if (noTrigger.length) todo('建制层', 'GV008', `${noTrigger.length} 个节点无 trigger（${noTrigger.map((n) => n.id).join(', ')}）——是死节点还是漏接线，须人判断`);

  if (!NODES(c).some((n) => typeof n.maxRuns === 'number')) {
    for (const n of NODES(c)) {
      if (/review|revise|repair|patch|评审|修订/i.test(`${n.id} ${n.title || ''} ${n.role || ''}`)) {
        n.maxRuns = 4;
        add('建制层', 'GV009', `节点 ${n.id} 补 maxRuns=4（回路刹车）`);
      }
    }
  }

  /* ============ 战术层 + 裁决层：护栏与机器门 ============ */

  /* 护栏挂载点：不能只认叫 "intake" 的节点。
   * 踩过的坑：memory.store 的入口是 llm:recall、sys.genesis 的入口是 fn:genesis.spec，
   * 只认 intake 会让这两条链永远补不上护栏，而它们恰恰一个写记忆、一个写链文件，
   * 是最需要护栏的两条。
   *
   * 三级识别，越靠前越理想：
   *   1) 有 intake 归一化节点 → 挂在它的 *.ready 之后（输入已校验，最干净）
   *   2) 入口是 fn 且声明了 *.ready → 同上，挂在校验之后
   *   3) 入口直接是业务节点 → 只能挂在 chain.start，读原始 $.input
   */
  const startNode = NODES(c).find((n) => trigsOn(n, 'chain.start'));
  const intakeNode = byId(c, 'intake') || NODES(c).find((n) => n.use === 'intake')
    || (startNode && startNode.kind === 'fn' && A(startNode.declares).some((s) => /\.ready$/.test(s)) ? startNode : null);
  let bailNode = byId(c, 'bail')
    || NODES(c).find((n) => n.halt === true && n.use === 'deliver' && n.id !== 'deliver');

  // 交付节点同理不能只认 use:'deliver'——sys.genesis 的收口是 fn:genesis.report。
  // 判据回到本质：halt:true 且不是那个「提前终止」的 bail。
  const deliverNode = byId(c, 'deliver')
    || NODES(c).find((n) => n.use === 'deliver' && n.halt === true && n !== bailNode)
    || NODES(c).find((n) => n.halt === true && n !== bailNode);

  let entryReady = null;
  let inputPath = '$.intake';
  if (intakeNode) {
    const ready = A(intakeNode.declares).find((s) => /\.ready$/.test(s)) || `${intakeNode.id}.ready`;
    entryReady = `signal.${ready}`;
    inputPath = typeof intakeNode.out === 'string' && intakeNode.out.startsWith('$.') ? intakeNode.out : '$.intake';
  } else if (startNode) {
    // 没有入口校验节点，护栏只能是第一道：直接接 chain.start，读原始输入
    entryReady = 'chain.start';
    inputPath = '$.input';
  }

  const wantClarify = opts.clarify !== false;

  if (wantClarify && !like(c, /clarify|护栏|澄清|guard|disambig/i)) {
    if (!entryReady) {
      todo('战术层', 'GV014', '找不到 intake 入口节点，无法确定护栏挂载点——需人指定 clarify 应订阅哪个信号');
    } else {
      // 关键接线：原本吃 intake.ready 的节点改吃 redlines.pass，护栏串进主干
      const downstream = NODES(c).filter((n) => n.id !== 'clarify' && n.id !== 'redlines' && trigsOn(n, entryReady) && n !== bailNode);
      const hasRedlineNode = !!byId(c, 'redlines');
      const passSignal = 'signal.redlines.pass';

      const clarify = clarifyNode(c, {
        entryReady,
        inputPath,
        highRiskActions: opts.highRiskActions,
        boundaryHint: opts.boundaryHint,
      });
      if (intakeNode) insertAfter(c, intakeNode.id, clarify);
      else c.nodes.unshift(clarify);
      add('战术层', 'GV014', ' 新增 clarify 意图护栏节点（llm），高危不可逆意图 → clarify.block → bail');

      if (!hasRedlineNode) {
        insertAfter(c, 'clarify', redlinesNode(opts));
        add('裁决层', 'GV004', '新增 redlines 硬拦截门（fn），五条机器检查：定标准 / 伪造证据 / 跳门 / 越界 / 丢证据');
      }

      for (const n of downstream) {
        n.trigger = A(n.trigger).map((t) => (t && t.on === entryReady ? { ...t, on: passSignal } : t));
        rewires.push({ node: n.id, from: entryReady, to: passSignal, why: '护栏串入主干：入口通过后先过 clarify + redlines 才准执行' });
      }

      if (bailNode) {
        for (const sig of ['signal.clarify.block', 'signal.redlines.fail']) {
          if (!trigsOn(bailNode, sig)) {
            bailNode.trigger = A(bailNode.trigger).concat([{ on: sig }]);
            rewires.push({ node: bailNode.id, from: '(新增)', to: sig, why: '护栏拦截后必须有终止出口，否则链会悬停' });
          }
        }
        if (/输入缺少可执行目标/.test(bailNode.title || '') || bailNode.title === '入参非法，提前终止') {
          bailNode.title = '入参非法或触碰红线，提前终止';
        }
        if (bailNode.in && bailNode.in.quality && /输入缺少可执行目标/.test(String(bailNode.in.quality.reason || ''))) {
          bailNode.in.quality.reason = '输入缺少可执行目标，或触碰红线 / 高危意图待人裁定';
        }
      } else {
        // 没有 bail 就造一个。拦截了却没有出口，链会悬停到预算耗尽——
        // 那比不拦截还糟：既花了钱，又没人知道为什么停了。
        bailNode = {
          id: 'bail',
          kind: 'fn',
          title: '触碰红线或高危意图待裁定，提前终止',
          use: 'deliver',
          trigger: [{ on: 'signal.clarify.block' }, { on: 'signal.redlines.fail' }],
          in: {
            answer: null,
            quality: { aborted: true, reason: '触碰红线，或意图指向不可逆高危动作，已交回战略层（人）裁定' },
          },
          out: '$.output',
          halt: true,
          declares: ['chain.end'],
        };
        insertAfter(c, 'redlines', bailNode);
        add('裁决层', 'bail', '新增 bail 终止节点，为 clarify.block / redlines.fail 提供收口出口');
      }
    }
  }

  /* ---- 裁决层：evidence → assert → deliver ---- */

  if (!deliverNode) {
    todo('裁决层', 'GV018', '找不到 deliver 交付节点，无法挂载 evidence / assert / 完成包');
  } else {
    const hasEvidence = !!byId(c, 'evidence');
    const hasAssert = !!byId(c, 'assert') || NODES(c).some((n) => n.kind === 'fn' && n.use === 'assert');

    // 交付前原有的触发信号，整体让位给 evidence
    const deliverTriggers = A(deliverNode.trigger).slice();

    if (!hasEvidence) {
      const artifacts = {};
      for (const n of NODES(c)) {
        if (['intake', 'clarify', 'redlines', 'bail', 'evidence', 'assert', 'deliver'].includes(n.id)) continue;
        if (typeof n.out === 'string' && n.out.startsWith('$.')) artifacts[n.id] = n.out;
      }
      insertBefore(c, deliverNode.id, evidenceNode(deliverTriggers, artifacts));
      add('军报', 'GV021', `新增 evidence 证据层节点（fn），归档 ${Object.keys(artifacts).length} 项产物 + SHA256 短哈希 + 可重跑命令`);
    }

    if (!hasAssert) {
      const conds = [];
      if (byId(c, 'redlines') || like(c, /redline|红线/i)) {
        conds.push({ expr: '$.redlines.passed == true', msg: '红线门未通过', where: 'redlines', severity: 'critical' });
      }
      conds.push({ expr: '$.evidence != null', msg: '证据包未生成', where: 'evidence', severity: 'high' });
      conds.push({ expr: 'len($.evidence.hashes) >= 1', msg: '证据 Hash 为空，产出无法验真', where: 'evidence', severity: 'medium' });
      if (like(c, /review|评审|critic/i)) {
        conds.push({ expr: '$.review.score >= 0.6', msg: '质量评分低于交付门槛 0.6', where: 'review', severity: 'medium' });
      }
      const answerExpr = deliverNode.in && typeof deliverNode.in.answer === 'string'
        ? String(deliverNode.in.answer).replace(/^=/, '') : null;
      if (answerExpr && /^[$a-zA-Z]/.test(answerExpr)) {
        conds.push({ expr: `${answerExpr} != null`, msg: '主产出为空', where: 'deliver.answer', severity: 'high' });
      }
      insertBefore(c, deliverNode.id, assertNode(conds));
      add('裁决层', 'GV017', `新增 assert 机器验证门（fn），${conds.length} 条确定性断言`);
    }

    if (!hasEvidence || !hasAssert) {
      deliverNode.trigger = [{ on: 'signal.assert.passed' }, { on: 'signal.assert.failed' }];
      rewires.push({
        node: deliverNode.id,
        from: deliverTriggers.map((t) => t && t.on).join(' | '),
        to: 'signal.assert.passed | signal.assert.failed',
        why: '交付前强制过证据 + 断言两道机器门；断言失败也放行到 deliver，但完成包里会带 issues，人能看到为什么不合格',
      });
    }

    if (!(deliverNode.in && deliverNode.in.completionPackage)) {
      deliverNode.in = deliverNode.in || {};
      const hasReview = !!like(c, /review|评审|critic/i);
      const rtCount = A(c.regressionTests).length;
      deliverNode.in.completionPackage = {
        scope: opts.scope || c.intent || c.title || '本次链运行产出',
        changeScope: '本次运行实际触达的节点与产物见 artifacts；未触达的分支不在本次交付范围内。',
        designRationale: '四层治理骨架：战略层由链头 intent/principle/acceptance/redlines/boundaries 固定；建制层由 trigger 拓扑 + budget + maxRuns 约束；战术层 AI 在边界内执行，越界经 clarify 交回人；裁决层由 redlines / review / evidence / assert 四道机器门判定，不接受 AI 自证。',
        risks: hasReview ? '$.review.weaknesses' : [],
        acceptanceCommand: `="node src/cli.js run ${c.id} --goal \\"" + coalesce($.intake.goal, "") + "\\""`,
        verificationResults: '$.evidence.gates',
        regressionCompatibility: `链头 regressionTests 共 ${rtCount} 条；治理基线注入只新增护栏与证据节点、不改变原有阶段语义，回归口径不变。`,
        issuesAndMethods: '$.assert.issues',
        openItems: hasReview ? '$.review.suggestions' : [],
        nextSteps: A(opts.nextSteps).length ? A(opts.nextSteps) : GOV_NEXT_STEPS.slice(),
        artifactsHash: '=$.evidence.hashes',
        narrative: {
          layer: '叙述层（AI 写给人看）',
          note: '以下由模型总结，供人快速决策：干了什么、卡在哪、需要你定什么。可读性优先，不作为验收依据。',
          summary: hasReview ? '=coalesce($.revised.patched, $.review.summary, "见 answer")' : '见 answer',
        },
        evidence: {
          layer: '证据层（机器统计，不可编造）',
          note: '以下全部由 fn 节点确定性生成，模型无法改写；验收以本层为准。',
          runId: '$.evidence.runId',
          command: '$.evidence.command',
          gates: '$.evidence.gates',
          hashes: '=$.evidence.hashes',
          assertions: '$.assert',
        },
      };
      add('裁决层', 'GV019/GV020/GV022', '为 deliver 装配 completionPackage（13 字段），叙述层与证据层显式分离标注');
    }

    if (!/叙述层|证据层/.test(deliverNode.title || '')) {
      deliverNode.title = `${deliverNode.title || '收敛交付'}（叙述层 + 证据层 + 完成包）`;
    }
  }

  /* ============ 建制层收尾：回归用例（须在节点补完之后生成） ============ */

  const rt0 = A(c.regressionTests).length;
  if (rt0 < 3) {
    const gen = [];
    const seq = rt0;
    const tag = (c.id || 'chain').split('.').pop().toUpperCase().slice(0, 8);
    gen.push({
      id: `RT-${tag}-${seq + 1}`,
      type: 'happy',
      input: '一个本链 intent 范围内、目标明确的正常请求',
      expect: '链走完主干阶段并从 deliver 终止，output.completionPackage 字段齐全，evidence.hashes 非空',
      rationale: '主路径必须可达终点，这是所有其他用例的前提',
    });
    gen.push({
      id: `RT-${tag}-${seq + 2}`,
      type: 'guard',
      input: '空目标或只有一句无法执行的模糊话',
      expect: 'intake 判非法 → intake.invalid → bail 终止，不进入任何 llm 节点',
      rationale: '垃圾输入不该烧预算',
    });
    gen.push({
      id: `RT-${tag}-${seq + 3}`,
      type: 'governance',
      input: '含高危不可逆措辞的目标（如「删掉现有实现从零重写」）',
      expect: 'clarify 判为 (B) 并 emit clarify.block → bail 拦截；接真实模型时须拦住，mock 下因占位放行须以真实模型复验',
      rationale: '护栏形同虚设是本框架最贵的失败模式',
    });
    c.regressionTests = A(c.regressionTests).concat(gen).slice(0, Math.max(3, rt0 + 3));
    add('建制层', 'GV010', `regressionTests ${rt0} → ${c.regressionTests.length} 条（补入主路径 / 垃圾输入 / 护栏拦截三类）`);
  }

  /* ============ 字段顺序整理：人读链头时希望战略层排在最前 ============ */
  const ORDER = ['id', 'title', 'version', 'tier', 'intent', 'principle', 'acceptance', 'redlines', 'boundaries', 'budget', 'regressionTests', 'nodes'];
  const ordered = {};
  for (const k of ORDER) if (k in c) ordered[k] = c[k];
  for (const k of Object.keys(c)) if (!(k in ordered)) ordered[k] = c[k];

  const after = evaluate(ordered);
  return { chain: ordered, added, manual, rewires, before, after };
}

module.exports = {
  applyGovernanceBaseline,
  GOV_PRINCIPLES,
  GOV_ACCEPTANCE,
  GOV_REDLINES,
};
