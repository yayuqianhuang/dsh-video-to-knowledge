'use strict';
/**
 * templates.js —— 角色提示词模板库
 *
 * 设计取向：**不让模型直接生成整条链的 JSON**。
 * 模型只负责设计「蓝图」（有哪些阶段、什么角色、什么顺序），
 * 由脚手架把蓝图编译成合法链定义。原因很简单：
 *   - 模型写 300 行嵌套 JSON 的出错率远高于写 20 行蓝图；
 *   - 提示词的质量应该沉淀在模板里被复用和迭代，而不是每次现编。
 *
 * 每个模板返回：{ system, user, expect, declares, temperature }
 */

/** 所有 llm 节点共享的硬约束。这是「JSON 触发链」之所以成立的契约基石。 */
const HARD_RULES = [
  '你是一条 AI JSON 触发链上的一个执行单元，不是聊天助手。',
  '只输出一个 JSON 对象。不要代码围栏，不要解释，不要寒暄，不要在 JSON 前后添加任何字符。',
  '输出必须是统一信封格式：{"meta":{},"data":{},"signals":[],"issues":[]}。',
  '  meta   放置 confidence（0-1 的自评置信度）与你认为重要的元信息；',
  '  data   放置本节点的实质产出，必须严格符合下方给出的输出契约；',
  '  signals 放置你判断应当触发的下游信号名，只能从「可用信号」中选择；',
  '  issues 放置你发现的问题，格式 {"severity":"low|medium|high|critical","where":"","msg":""}。',
  '证据不足时，把对应字段置为 null 并在 issues 中说明，绝不允许编造。',
  '如果输入自相矛盾，不要自行折中，必须在 issues 中显式指出冲突。',
  '你是一个可被逐步观察的执行单元：整条链的运行过程（每个节点的触发、输入、产出、信号）都会被追踪器记录并可逐步复盘，不要把中间过程当黑箱。',
  '版本号遵循三段式 v主.次.修：① 每个新链的初始版本一律为 v0.0.1（原型稿/测试版）；② 第一位 MAJOR：发生「大版本更新」(不兼容变更、架构级重构、删除/重命名节点 id、改信号协议或 envelope 契约结构)时升 1 并归零后两位；③ 第二位 MINOR：新增或更新某个「模块」(节点、角色、子能力、整段逻辑)时升 1 并归零 PATCH；④ 第三位 PATCH：小需求变动(文案/调参/字段微调/单节点局部改动/小 bug 修复)时升 1。绝不要无脑升 MAJOR。',
].join('\n');

function systemOf({ role, duty, chain, principle, signals, expectText }) {
  const parts = [
    HARD_RULES,
    '',
    `【你的角色】${role}`,
    `【你的职责】${duty}`,
    chain?.intent ? `【所属链的意图】${chain.intent}` : '',
    (principle && principle.length) ? `【本链的设计原则】\n${principle.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}` : '',
    signals && signals.length ? `【可用信号】${signals.join(' / ')}` : '',
    expectText ? `【输出契约 data 必须满足】\n${expectText}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

const S = (t) => ({ type: 'string' });
const ARR = (items, min) => ({ type: 'array', ...(min != null ? { minItems: min } : {}), items });

/* ------------------------------------------------------------------ *
 *  角色模板库
 * ------------------------------------------------------------------ */
const ROLES = {
  /* ---- 分而治之族 ---- */
  'complexity-assessor': {
    duty: '判断目标是否需要分解。过度分解和分解不足同样有害，你要给出量化依据而不是感觉。',
    expect: {
      type: 'object', required: ['score', 'atomic', 'reason'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 1 },
        atomic: { type: 'boolean' },
        dimensions: { type: 'object' },
        reason: S(),
      },
    },
    signals: ['atomic.enough', 'too.complex'],
  },
  decomposer: {
    duty: '把目标切成一组可独立执行、可独立验收的原子任务。切分单位是「可独立验收」，不是「看起来差不多大」。',
    expect: {
      type: 'object', required: ['strategy', 'tasks'],
      properties: {
        strategy: S(),
        tasks: ARR({
          type: 'object', required: ['id', 'title', 'goal', 'acceptance'],
          properties: { id: S(), title: S(), goal: S(), inputs: ARR(S()), outputs: ARR(S()), acceptance: ARR(S(), 1), est: { type: 'number' } },
        }, 2),
      },
    },
    signals: ['split.done'],
  },
  'dependency-mapper': {
    duty: '识别子任务之间的依赖，产出分层执行计划，标出关键路径与可并行集合。',
    expect: {
      type: 'object', required: ['edges', 'layers'],
      properties: { edges: ARR({ type: 'object', required: ['from', 'to'] }), layers: { type: 'array' }, criticalPath: ARR(S()), parallelizable: { type: 'array' } },
    },
    signals: ['deps.done'],
  },
  merger: {
    duty: '把分头产出的结果合并成一致的整体，主动找出彼此冲突或重复的部分，不要简单拼接。',
    expect: { type: 'object', required: ['merged'], properties: { merged: {}, conflicts: { type: 'array' }, coverage: { type: 'number' } } },
    signals: ['merge.done'],
  },

  /* ---- 流水线族 ---- */
  normalizer: {
    duty: '把杂乱输入归一化成统一契约：统一命名、统一单位、统一空值表示。丢弃了什么必须记录。',
    expect: { type: 'object', required: ['normalized'], properties: { normalized: {}, dropped: { type: 'array' }, notes: S() } },
    signals: ['stage.done'],
  },
  enricher: {
    duty: '为数据补充上下文与领域信息。补充的每一项都要标注来源，无来源的推测不要写入。',
    expect: { type: 'object', required: ['enriched'], properties: { enriched: {}, added: ARR(S()) } },
    signals: ['stage.done'],
  },
  transformer: {
    duty: '执行确定性的形态变换。变换必须可逆或可追溯，记录你做了哪些操作。',
    expect: { type: 'object', required: ['output'], properties: { output: {}, ops: ARR(S()) } },
    signals: ['stage.done'],
  },
  'stage-validator': {
    duty: '在流水线的每一段出口做质检，只判定是否符合契约，不修改数据。',
    expect: { type: 'object', required: ['passed'], properties: { passed: { type: 'boolean' }, checked: ARR(S()), violations: { type: 'array' } } },
    signals: ['stage.validated', 'stage.rejected'],
  },

  /* ---- 结构化族 ---- */
  segmenter: {
    duty: '把非结构文本切分为语义段落，并标注每段的类型，为后续抽取提供定位锚点。',
    expect: { type: 'object', required: ['segments'], properties: { segments: ARR({ type: 'object', required: ['id', 'type'] }, 1) } },
    signals: ['segment.done'],
  },
  'schema-inducer': {
    duty: '从样本中归纳出 JSON Schema。宁可字段少而准，不要为了覆盖率编造字段。每个字段要指出证据位置。',
    expect: {
      type: 'object', required: ['schema', 'fields'],
      properties: { schema: { type: 'object' }, fields: ARR({ type: 'object', required: ['name', 'type'] }, 1), coverage: { type: 'number' } },
    },
    signals: ['schema.ready'],
  },
  structurizer: {
    duty: '按给定 Schema 把文本转成结构化记录。无法映射的内容要放进 unmapped，不要硬塞。',
    expect: { type: 'object', required: ['records'], properties: { records: { type: 'array' }, coverage: { type: 'number' }, unmapped: { type: 'array' } } },
    signals: ['structurize.done'],
  },

  /* ---- 提取族 ---- */
  extractor: {
    duty: '按字段清单抽取信息。每一项必须附带原文证据；找不到就返回 null 并列入 missing。绝不允许推测填充。',
    expect: {
      type: 'object', required: ['items'],
      properties: {
        items: ARR({ type: 'object', required: ['field', 'value'], properties: { field: S(), value: {}, evidence: S(), confidence: { type: 'number' } } }, 1),
        missing: { type: 'array' },
      },
    },
    signals: ['extract.done', 'extract.incomplete'],
  },

  /* ---- 解释族 ---- */
  explainer: {
    duty: '给定系统术语或术语清单，给出每个术语的定义、关联术语，以及在整套系统中的必然性（what/why/how/who/when/where 六问）。解释必须基于本系统的真实机制，不可臆造。',
    expect: {
      type: 'object', required: ['entries'],
      properties: {
        entries: ARR({ type: 'object', required: ['term', 'definition', 'necessity'],
          properties: {
            term: S(),
            definition: S(),
            related: ARR(S()),
            necessity: { type: 'object', required: ['what', 'why', 'how', 'who', 'when', 'where'],
              properties: { what: S(), why: S(), how: S(), who: S(), when: S(), where: S() } },
          } }, 1),
      },
    },
    signals: ['explain.done'],
  },

  /* ---- 商业分析族 ---- */
  'business-analyst': {
    duty: '针对一个商业想法或业务话题，给出结构化、可落地的分析。必须覆盖：市场现状与信息分散度、盈利模式设计（佣金/会员/增值服务分层）、核心痛点与落地推演、替代方案，并给出结论。所有论断需基于可核验事实或明确标注为假设，不可臆造数据。',
    expect: {
      type: 'object', required: ['marketStatus', 'profitModel', 'painPoints', 'alternatives', 'conclusion'],
      properties: {
        marketStatus: { type: 'object', required: ['summary', 'infoFragmentation'], properties: { summary: S(), platforms: ARR(S()), infoFragmentation: S() } },
        profitModel: { type: 'object', required: ['layers'], properties: { layers: ARR(S()), commission: S(), membership: S(), valueAdded: S() } },
        painPoints: { type: 'object', required: ['core', 'feasibility'], properties: { core: ARR(S()), feasibility: S() } },
        alternatives: { type: 'object', required: ['options'], properties: { options: ARR(S()), recommendation: S() } },
        conclusion: S(),
      },
    },
    signals: ['analysis.done'],
  },

  /* ---- 生成族 ---- */
  outliner: {
    duty: '先搭骨架再写内容。大纲要覆盖全部验收条件，每个小节标明要点。',
    expect: { type: 'object', required: ['outline'], properties: { outline: ARR({ type: 'object', required: ['h'] }, 2) } },
    signals: ['outline.done'],
  },
  generator: {
    duty: '按大纲与契约产出内容。宁可写得少而扎实，不要注水。每个论断都要能对应到输入证据。',
    expect: { type: 'object', required: ['draft'], properties: { draft: S(), sections: ARR(S()), wordCount: { type: 'number' } } },
    signals: ['generate.done'],
  },
  polisher: {
    duty: '只做表达层打磨：术语统一、长句拆分、消除歧义。不得改变事实与结论。',
    expect: { type: 'object', required: ['final'], properties: { final: S(), changes: { type: 'array' } } },
    signals: ['polish.done'],
  },

  /* ---- 总结族 ---- */
  'fact-harvester': {
    duty: '先把可核验的事实抽成条目再谈总结。每条事实标注来源，不可核验的一律不收。',
    expect: { type: 'object', required: ['facts'], properties: { facts: ARR({ type: 'object', required: ['id', 'text'] }, 1) } },
    signals: ['facts.done'],
  },
  summarizer: {
    duty: '产出三档摘要（一句话/简要/完整）。摘要必须只包含上游事实中出现过的内容，不得引入新信息。',
    expect: {
      type: 'object', required: ['oneline', 'brief'],
      properties: { oneline: { type: 'string', maxLength: 120 }, brief: S(), full: S(), keyPoints: ARR(S()), confidence: { type: 'number' } },
    },
    signals: ['summary.done'],
  },

  /* ---- 优化族 ---- */
  'baseline-metric': {
    duty: '先量化现状再谈优化。给出可复现的度量口径，没有基线的优化都是错觉。',
    expect: { type: 'object', required: ['metrics'], properties: { metrics: { type: 'object' }, method: S() } },
    signals: ['baseline.done'],
  },
  'bottleneck-analyst': {
    duty: '定位真正的瓶颈并量化影响占比。按影响排序，不要罗列所有能想到的问题。',
    expect: {
      type: 'object', required: ['bottlenecks'],
      properties: { bottlenecks: ARR({ type: 'object', required: ['where', 'impact'], properties: { where: S(), impact: { type: 'number' }, evidence: S(), type: S() } }, 1) },
    },
    signals: ['bottleneck.done'],
  },
  'hypothesis-generator': {
    duty: '针对瓶颈提出候选改进方案，每个方案给出 impact/cost/risk/confidence 四维打分，供下游加权排序。',
    expect: {
      type: 'object', required: ['candidates'],
      properties: { candidates: ARR({ type: 'object', required: ['id', 'action', 'metrics'] }, 2) },
    },
    signals: ['hypothesis.done'],
  },
  'optimizer-planner': {
    duty: '把选中的方案排成有先后的行动计划，说明每步的预期收益与风险。只排能验证的步骤。',
    expect: { type: 'object', required: ['direction', 'plan'], properties: { direction: S(), plan: ARR({ type: 'object', required: ['step', 'action'] }, 1), risks: ARR(S()) } },
    signals: ['optimize.plan.ready'],
  },

  /* ---- 自我迭代族 ---- */
  critic: {
    duty: '严格评审，给出 0-1 分与具体缺陷。你的价值在于找出问题，不是鼓励。没有缺陷时才允许 weaknesses 为空。',
    expect: {
      type: 'object', required: ['score', 'weaknesses'],
      properties: {
        score: { type: 'number', minimum: 0, maximum: 1 },
        strengths: ARR(S()),
        weaknesses: ARR({ type: 'object', required: ['where', 'severity', 'msg'] }),
        suggestions: { type: 'array' },
      },
    },
    signals: ['critique.hasIssues', 'critique.clean'],
    temperature: 0.1,
  },
  patcher: {
    duty: '只修评审明确指出的问题，逐条回应。你认为不该改的要放进 rejected 并说明理由，不要沉默地忽略。',
    expect: { type: 'object', required: ['patched'], properties: { patched: {}, applied: { type: 'array' }, rejected: { type: 'array' } } },
    signals: ['patch.done'],
  },

  /* ---- 自我测试族 ---- */
  'test-designer': {
    duty: '设计测试用例，必须覆盖 happy / edge / adversarial / regression 四类。对抗用例要真的能打到痛处。',
    expect: {
      type: 'object', required: ['cases'],
      properties: { cases: ARR({ type: 'object', required: ['id', 'type', 'expect'] }, 3), coverage: { type: 'object' } },
    },
    signals: ['tests.ready'],
  },
  'test-executor': {
    duty: '逐条执行用例并如实记录。不要为了让结果好看而放宽判定标准，失败就是失败。',
    expect: {
      type: 'object', required: ['results', 'passRate'],
      properties: { results: ARR({ type: 'object', required: ['id', 'pass'] }, 1), passed: { type: 'number' }, failed: { type: 'number' }, passRate: { type: 'number' } },
    },
    signals: ['test.passed', 'test.failed'],
    temperature: 0,
  },

  /* ---- 自我找 bug 族 ---- */
  'bug-localizer': {
    duty: '从失败现象反推可疑位置，按置信度排序。给出定位依据，不要泛泛地说"某处可能有问题"。',
    expect: { type: 'object', required: ['suspects'], properties: { suspects: ARR({ type: 'object', required: ['where', 'confidence'] }, 1), narrowedTo: S() } },
    signals: ['localize.done'],
  },
  'root-cause': {
    duty: '提出根因假设并给出最小复现路径。区分「症状」和「原因」，只有能解释全部现象的才算根因。',
    expect: {
      type: 'object', required: ['hypotheses', 'minimalRepro'],
      properties: { hypotheses: ARR({ type: 'object', required: ['id', 'cause', 'likelihood'] }, 1), minimalRepro: S(), chosen: S() },
    },
    signals: ['rootcause.done'],
  },
  fixer: {
    duty: '给出针对根因的最小修复，并指定回归用例。优先把隐性期望改写成可被校验拦截的显性契约。',
    expect: { type: 'object', required: ['fix'], properties: { fix: { type: 'object', required: ['where', 'change'] }, risk: S(), regressionTests: ARR(S()) } },
    signals: ['fix.applied'],
  },

  /* ---- 自我梳理族 ---- */
  'knowledge-distiller': {
    duty: '把本次运行的经验蒸馏成可复用的教训，每条必须有具体证据支撑，不要写正确的废话。',
    expect: { type: 'object', required: ['lessons'], properties: { lessons: ARR({ type: 'object', required: ['topic', 'insight'] }, 1) } },
    signals: ['lessons.done'],
  },
  organizer: {
    duty: '把零散教训整理成条件-动作形式的 playbook，并剪掉已经过时的条目。',
    expect: { type: 'object', required: ['playbook'], properties: { playbook: ARR({ type: 'object', required: ['pattern', 'do'] }, 1), prune: { type: 'array' }, nextFocus: S() } },
    signals: ['organize.done'],
  },

  /* ---- 治理族 ---- */
  'governance-assessor': {
    duty: '作为链治理官，扫描链注册表与 skill 注册表，识别重复意图、版本号异常、缺失验收门、可合并的链，并按优先级给出优化与合并建议。所有结论必须基于真实扫描数据，不得臆造。',
    expect: {
      type: 'object', required: ['summary', 'optimizationPlan', 'mergePlan'],
      properties: {
        summary: S(),
        chainStats: { type: 'object' },
        skillStats: { type: 'object' },
        optimizationPlan: ARR({ type: 'object', required: ['target', 'reason', 'action'], properties: { target: S(), reason: S(), action: S(), priority: S() } }, 1),
        mergePlan: ARR({ type: 'object', required: ['candidates', 'reason', 'approach'], properties: { candidates: ARR(S()), reason: S(), approach: S(), priority: S() } }, 0),
        newSkillSuggestions: ARR({ type: 'object', required: ['skill', 'reason'], properties: { skill: S(), reason: S() } }, 0),
      },
    },
    signals: ['governance.assessed'],
    temperature: 0.2,
  },

  /* ---- 元链专用 ---- */
  'chain-architect': {
    duty: '为给定目标设计一条触发链的蓝图。你只设计阶段序列与角色分工，不要输出完整链 JSON——编译由脚手架负责。阶段数控制在 3-7 个，每个阶段必须有明确产出。',
    expect: {
      type: 'object', required: ['chainId', 'title', 'intent', 'stages'],
      properties: {
        chainId: { type: 'string', pattern: '^[a-z][a-z0-9]*(\\.[a-z0-9-]+)+$' },
        title: S(),
        intent: S(),
        principle: ARR(S()),
        stages: ARR({
          type: 'object', required: ['id', 'role', 'intent'],
          properties: { id: { type: 'string', pattern: '^[a-z][a-zA-Z0-9_]*$' }, role: S(), title: S(), intent: S(), produces: ARR(S()) },
        }, 2),
        qualityGate: { type: 'boolean' },
        iterate: { type: 'object' },
        acceptance: ARR(S()),
      },
    },
    signals: ['blueprint.ready'],
    temperature: 0.3,
  },
  'chain-fixer': {
    duty: '根据 linter 报告修复链定义。只输出补丁操作，不要重写整条链。每个补丁要对应一条 linter finding 的规则编号。',
    expect: {
      type: 'object', required: ['patches'],
      properties: {
        patches: ARR({
          type: 'object', required: ['op', 'path'],
          properties: {
            op: { type: 'string', enum: ['set', 'merge', 'push', 'remove'] },
            path: S(),
            value: {},
            rule: S(),
            reason: S(),
          },
        }),
        unfixable: { type: 'array' },
      },
    },
    signals: ['repair.ready', 'repair.impossible'],
    temperature: 0.1,
  },

  /* ---- 兜底 ---- */
  generic: {
    duty: '按上游输入完成本阶段任务，产出结构化结果。',
    expect: { type: 'object' },
    signals: ['stage.done'],
  },
};

/** 把 expect Schema 压成人类/模型都好读的一段文字，塞进 system */
function schemaToText(schema, indent = '') {
  if (!schema || typeof schema !== 'object') return `${indent}任意 JSON`;
  if (schema.type === 'array') return `${indent}数组${schema.minItems ? `（至少 ${schema.minItems} 项）` : ''}，每项：\n${schemaToText(schema.items, indent + '  ')}`;
  if (schema.type === 'object' || schema.properties) {
    const req = new Set(schema.required || []);
    const lines = Object.entries(schema.properties || {}).map(([k, v]) => {
      const t = Array.isArray(v.type) ? v.type.join('|') : (v.type || 'any');
      const flag = req.has(k) ? '必填' : '可选';
      let extra = '';
      if (v.enum) extra = `，取值 ${JSON.stringify(v.enum)}`;
      if (v.minimum != null || v.maximum != null) extra = `，范围 ${v.minimum ?? '-∞'}~${v.maximum ?? '+∞'}`;
      if (v.type === 'array' && v.minItems) extra = `，至少 ${v.minItems} 项`;
      return `${indent}  - ${k} (${t}, ${flag}${extra})`;
    });
    if (!lines.length) return `${indent}  任意对象`;
    return lines.join('\n');
  }
  return `${indent}${schema.type || 'any'}`;
}

/**
 * 生成一个 llm 节点的完整 prompt
 * @param {object} o { role, chain, stage, upstream: [{id,path,title}], signals }
 */
function buildPrompt(o) {
  const tpl = ROLES[o.role] || ROLES.generic;
  const expect = o.expect || tpl.expect;
  const signals = o.signals || tpl.signals || ['stage.done'];

  const system = systemOf({
    role: o.role,
    duty: o.duty || tpl.duty,
    chain: o.chain,
    principle: o.chain?.principle,
    signals,
    expectText: schemaToText(expect),
  });

  const upstreamBlock = (o.upstream || []).length
    ? (o.upstream || []).map((u) => `【${u.title || u.id}】\n{{${u.path}}}`).join('\n\n')
    : '（本阶段为链首，直接使用原始目标）';

  const user = [
    `【总目标】\n{{$.intake.goal}}`,
    o.stage?.intent ? `【本阶段任务】\n${o.stage.intent}` : '',
    `【上游产出】\n${upstreamBlock}`,
    o.chain?.acceptance?.length ? `【最终验收条件】\n${o.chain.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : '',
    '',
    '现在输出你的 JSON 信封。',
  ].filter(Boolean).join('\n\n');

  return { system, user, expect, declares: signals, temperature: o.temperature ?? tpl.temperature ?? 0.2 };
}

module.exports = { ROLES, buildPrompt, schemaToText, HARD_RULES, systemOf };
