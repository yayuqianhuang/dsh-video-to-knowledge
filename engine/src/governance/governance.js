'use strict';
/**
 * governance.js —— 「带 AI 打仗」四层治理的机器门（唯一真源）
 *
 * 图解框架的核心主张：AI 能不能被信任，不取决于它说自己干完了，
 * 而取决于「人定的目标」「机器验的证据」这两头有没有被结构化地钉进链里。
 * 所以治理不能只写在提示词里，必须变成 lint 能查的字段与节点。
 *
 * 四层 + 两层军报：
 *   战略层（人）  intent / principle / acceptance / redlines / boundaries
 *                 —— AI 不得篡改，只能执行与追问
 *   建制层（拓扑）budget / expect 契约 / trigger / maxRuns / regressionTests / halt
 *                 —— 决定这支部队能不能被指挥、会不会失控
 *   战术层（AI）  llm / fn / gate / clarify 护栏
 *                 —— AI 在边界内自由发挥，越界时必须回头问人
 *   裁决层（机器）lint / review / assert / deliver / completionPackage
 *                 —— 不接受 AI 自证，只认机器门
 *   两层军报      叙述层（AI 写给人看）+ 证据层（机器出，不可编造）
 *
 * 链等级 tier：
 *   combat  作战链 —— 承担真实交付，四层治理全量要求，w3 缺失判 error
 *   utility 工具链 —— 内部小工具，w3 降级为 warn，w1/w2 降级为 info
 *   未显式声明时按规模推断：llm≥3 或 nodes≥10 视为作战链（从严）
 *
 * 规则编号 GV0xx，与验收门 G00x、静态检查 L0xx 三套编号互不重叠。
 */

const A = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const NODES = (c) => (Array.isArray(c.nodes) ? c.nodes : []);
const TEXT = (c) => JSON.stringify(c);
const llmNodes = (c) => NODES(c).filter((n) => n.kind === 'llm');

/** 节点是否命中某个语义角色：看 id / use / title / role 四处 */
const hasNode = (c, re) =>
  NODES(c).some((n) => re.test(n.id || '') || re.test(n.use || '') || re.test(n.title || '') || re.test(n.role || ''));

/**
 * 治理维度表。
 * w = 权重，同时决定 combat 链下的告警等级：3→error，2→warn，1→info
 * fix = 修复建议，直接给到能动手的粒度
 */
const DIMENSIONS = [
  /* ---------------- 战略层：人定目标，AI 不得篡改 ---------------- */
  {
    key: 'GV001', layer: '战略层', name: 'intent 意图声明', w: 2, where: '$.intent',
    check: (c) => !!c.intent && String(c.intent).length >= 20,
    msg: '缺少 intent 或过于简略：别的链与模型无从判断何时该复用它，人也无从校验 AI 有没有跑偏',
    fix: '补一句话讲清「这条链解决谁的什么问题、产出什么」，不少于 20 字',
  },
  {
    key: 'GV002', layer: '战略层', name: 'principle≥5 作战原则', w: 2, where: '$.principle',
    check: (c) => A(c.principle).length >= 5,
    msg: 'principle 少于 5 条：战略层约束不足，AI 在灰色地带只能自由发挥',
    fix: '补足到 5 条以上，覆盖「做什么/不做什么/冲突时听谁的」',
  },
  {
    key: 'GV003', layer: '战略层', name: 'acceptance≥5 验收标准', w: 2, where: '$.acceptance',
    check: (c) => A(c.acceptance).length >= 5,
    msg: 'acceptance 少于 5 条：这条链的「好」无法被判定，交付只能靠人肉感觉',
    fix: '把验收写成可判定句式（有/没有、数量、门槛），不要写「质量高」这类无法验的词',
  },
  {
    key: 'GV004', layer: '战略层', name: 'redlines 红线机制', w: 3, where: '$.redlines',
    check: (c) => hasNode(c, /redline|红线/i) || A(c.redlines).length >= 1 || A(c.principle).some((p) => /红线|禁止|不得|严禁/.test(String(p))),
    msg: '没有任何红线机制：战略禁区没进链，AI 越界时没有任何结构化拦截',
    fix: '加 $.redlines 数组，或加一个 fn:redlines 节点做硬拦截',
  },
  {
    key: 'GV005', layer: '战略层', name: 'boundaries 禁区/边界', w: 2, where: '$.boundaries',
    check: (c) => !!c.boundaries || /禁区|边界|不得越界|boundar/i.test(TEXT(c)),
    msg: '未声明作战边界：AI 不知道哪些是「不归我管」的区域，容易越权扩张任务范围',
    fix: '补 $.boundaries，明确本链不负责什么、越界时应交回给谁',
  },

  /* ---------------- 建制层：链拓扑、预算、契约 ---------------- */
  {
    key: 'GV006', layer: '建制层', name: 'budget 预算', w: 1, where: '$.budget',
    check: (c) => c.budget != null,
    msg: '未显式声明 budget，成本不可预测',
    fix: '显式写 budget.maxLlmCalls / maxSteps',
  },
  {
    key: 'GV007', layer: '建制层', name: 'llm 全量 expect 契约', w: 3, where: '$.nodes[*].expect',
    check: (c) => llmNodes(c).length === 0 || llmNodes(c).every((n) => n.expect && Object.keys(n.expect).length),
    msg: '存在没有 expect 输出契约的 llm 节点：模型跑偏时无法被机器拦截，脏数据会直接流进下游',
    fix: '给每个 llm 节点补 expect（哪怕只约束顶层字段类型）',
    detail: (c) => llmNodes(c).filter((n) => !(n.expect && Object.keys(n.expect).length)).map((n) => n.id),
  },
  {
    key: 'GV008', layer: '建制层', name: 'trigger 拓扑完备', w: 2, where: '$.nodes[*].trigger',
    check: (c) => NODES(c).every((n) => Array.isArray(n.trigger) && n.trigger.length > 0),
    msg: '存在没有 trigger 的节点，永远不会被唤醒',
    fix: '补 trigger，或删掉这个死节点',
    detail: (c) => NODES(c).filter((n) => !(n.trigger || []).length).map((n) => n.id),
  },
  {
    key: 'GV009', layer: '建制层', name: 'maxRuns 熔断', w: 2, where: '$.nodes[*].maxRuns',
    check: (c) => NODES(c).some((n) => typeof n.maxRuns === 'number'),
    msg: '全链没有任何 maxRuns 熔断：一旦出现回路只能靠预算耗尽收场',
    fix: '给可能反复触发的节点（review/revise/repair 类）设 maxRuns',
  },
  {
    key: 'GV010', layer: '建制层', name: 'regressionTests≥3', w: 2, where: '$.regressionTests',
    check: (c) => A(c.regressionTests).length >= 3,
    msg: 'regressionTests 少于 3 条：改动这条链之后没有任何东西能证明旧能力没被改坏',
    fix: '补回归用例，每条写清「输入特征 → 期望走到哪个节点/产出什么」',
  },
  {
    key: 'GV011', layer: '建制层', name: 'halt 可达终止', w: 1, where: '$.nodes[*].halt',
    check: (c) => NODES(c).some((n) => n.halt === true),
    msg: '没有任何 halt:true 的终止节点',
    fix: '给链尾节点设 halt:true',
  },

  /* ---------------- 战术层：AI 在边界内执行 ---------------- */
  {
    key: 'GV012', layer: '战术层', name: 'fn 确定性节点', w: 1, where: '$.nodes',
    check: (c) => NODES(c).some((n) => n.kind === 'fn'),
    msg: '全链没有确定性 fn 节点：所有环节都交给模型，结果不可复现',
    fix: '把归一化/统计/断言这类确定性工作交给 fn',
  },
  {
    key: 'GV013', layer: '战术层', name: 'gate 判别分流', w: 2, where: '$.nodes',
    check: (c) => NODES(c).some((n) => n.kind === 'gate'),
    msg: '没有 gate 判别节点：链只有一条直路，质量不达标时无法分流去返工',
    fix: '在 review 之后加 gate，按评分分流到 revise 或 deliver',
  },
  {
    key: 'GV014', layer: '战术层', name: 'clarify 意图护栏', w: 3, where: '$.nodes',
    check: (c) => hasNode(c, /clarify|护栏|澄清|guard|disambig/i),
    msg: '缺少 clarify 意图护栏：用户一句模糊指令，AI 可以单方把它理解成高危动作并直接执行，无人拦截',
    fix: '在入口之后加一个 llm:clarify 节点，对高危意图（删除/重写/迁移/资金）分支判别，命中红线走 bail 交回人裁定',
  },

  /* ---------------- 裁决层：机器门，不接受 AI 自证 ---------------- */
  {
    key: 'GV015', layer: '裁决层', name: '静态/扫描校验门', w: 2, where: '$.nodes',
    check: (c) => hasNode(c, /lint|static|check|校验|扫描|scan|explore/i),
    msg: '缺少静态校验/事实扫描门：AI 的判断没有客观事实作为输入，容易凭空推断',
    fix: '在分析前加 fn 扫描节点，把真实文件/结构读进黑板再让模型判断',
  },
  {
    key: 'GV016', layer: '裁决层', name: 'review 评审门', w: 2, where: '$.nodes',
    check: (c) => hasNode(c, /review|评审|assess|critic|verdict/i),
    msg: '缺少 review 评审门：产出没有独立评审环节',
    fix: '加一个 role:critic 的 llm 节点，对前序产出打分并列出必须修的问题',
  },
  {
    key: 'GV017', layer: '裁决层', name: 'assert/test 验证门', w: 3, where: '$.nodes',
    check: (c) => hasNode(c, /assert|test|verify|dryrun|验证/i) || NODES(c).some((n) => n.kind === 'fn' && n.use === 'assert'),
    msg: '缺少 assert/test 机器验证门：最终产出由 AI 自己宣布合格，这正是治理框架明确反对的「AI 自证」',
    fix: '在 deliver 前加 fn:assert 节点，用确定性断言校验完成包字段齐全、关键指标达标',
  },
  {
    key: 'GV018', layer: '裁决层', name: 'deliver 交付门', w: 1, where: '$.nodes',
    check: (c) => NODES(c).some((n) => n.use === 'deliver') || hasNode(c, /deliver|交付/i),
    msg: '缺少统一 deliver 交付节点，产出散落在黑板各处',
    fix: '加 fn:deliver 收口，halt:true 结束',
  },
  {
    key: 'GV019', layer: '裁决层', name: 'completionPackage 完成包', w: 3, where: '$',
    check: (c) => /completionPackage|完成包/i.test(TEXT(c)),
    msg: '交付没有完成包约束：变更/设计/风险/验收命令/验证/回归/未完成/下一步这些字段没人保证，人无法据此验收',
    fix: '在 deliver 的输入里组装 completionPackage，并用 assert 断言字段齐全',
  },

  /* ---------------- 两层军报：叙述归 AI，证据归机器 ---------------- */
  {
    key: 'GV020', layer: '军报', name: '叙述层军报（AI 写）', w: 2, where: '$.nodes',
    check: (c) => /叙述层|军报|narrative/i.test(TEXT(c)),
    msg: '没有叙述层军报：机器数据没有被翻译成人能快速决策的说明',
    fix: '让 deliver 或 report 节点产出一段面向人的叙述：干了什么、卡在哪、需要你定什么',
  },
  {
    key: 'GV021', layer: '军报', name: '证据层军报（机器出）', w: 2, where: '$.nodes',
    check: (c) => hasNode(c, /evidence|证据|traceStats|stats/i) || /证据层/i.test(TEXT(c)),
    msg: '没有证据层军报：所有结论都是 AI 的一面之词，缺少机器统计背书',
    fix: '加 fn 节点（如 traceStats / 自定义 evidence）汇总真实计数与命中项，与叙述层并列输出',
  },
  {
    key: 'GV022', layer: '军报', name: '叙述与证据分离', w: 2, where: '$.nodes',
    check: (c) => {
      const t = TEXT(c);
      return /叙述层/i.test(t) && /证据层/i.test(t);
    },
    msg: '叙述与证据没有分离：AI 写的话和机器出的数混在一起，读的人分不清哪句有据可查',
    fix: '完成包里显式拆成 narrative 与 evidence 两块，并注明证据由机器统计生成',
  },
];

/** 未显式声明 tier 时按规模从严推断 */
function inferTier(chain) {
  if (chain.tier === 'combat' || chain.tier === 'utility') return { tier: chain.tier, inferred: false };
  const llm = llmNodes(chain).length;
  const n = NODES(chain).length;
  return { tier: llm >= 3 || n >= 10 ? 'combat' : 'utility', inferred: true };
}

/** 权重 → 告警等级，随链等级降档 */
function levelFor(w, tier) {
  if (tier === 'utility') return w === 3 ? 'warn' : 'info';
  return w === 3 ? 'error' : w === 2 ? 'warn' : 'info';
}

/**
 * 评估一条链的治理覆盖度。
 * @returns {{tier, tierInferred, results, byLayer, score, passed, findings}}
 */
function evaluate(chain) {
  const { tier, inferred } = inferTier(chain);
  const results = [];
  const findings = [];
  const byLayer = {};
  let got = 0;
  let max = 0;

  for (const d of DIMENSIONS) {
    let ok = false;
    try { ok = !!d.check(chain); } catch { ok = false; }
    let detail;
    if (!ok && typeof d.detail === 'function') {
      try { detail = d.detail(chain); } catch { detail = undefined; }
    }
    results.push({ key: d.key, layer: d.layer, name: d.name, w: d.w, ok, ...(detail && detail.length ? { detail } : {}) });

    byLayer[d.layer] = byLayer[d.layer] || { got: 0, max: 0, missing: [] };
    byLayer[d.layer].max += d.w;
    max += d.w;
    if (ok) { byLayer[d.layer].got += d.w; got += d.w; }
    else {
      byLayer[d.layer].missing.push(d.key);
      findings.push({
        level: levelFor(d.w, tier),
        rule: d.key,
        where: d.where,
        msg: `[${d.layer}] ${d.name}：${d.msg}${detail && detail.length ? `（涉及节点：${detail.join(', ')}）` : ''}`,
        fix: d.fix,
      });
    }
  }

  const score = +(got / max).toFixed(3);
  const hardMissing = findings.filter((f) => f.level === 'error');

  return {
    tier,
    tierInferred: inferred,
    score,
    passed: hardMissing.length === 0,
    results,
    byLayer: Object.fromEntries(Object.entries(byLayer).map(([k, v]) => [k, { ...v, rate: +(v.got / v.max).toFixed(3) }])),
    findings,
    summary: {
      total: DIMENSIONS.length,
      hit: results.filter((r) => r.ok).length,
      errors: hardMissing.length,
      warnings: findings.filter((f) => f.level === 'warn').length,
      infos: findings.filter((f) => f.level === 'info').length,
    },
  };
}

module.exports = { DIMENSIONS, evaluate, inferTier, levelFor };
