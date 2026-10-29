'use strict';
/**
 * bootstrap.js —— 元链 sys.genesis 的构造器
 *
 * 一个能生成链的系统，它自己也应该是被生成出来的，否则「元」名不副实。
 * 所以 sys.genesis 不是手写的 JSON 文件，而是由这段代码构造后落盘的。
 * 你可以改这里再 `ajtc init --force`，让元系统重新生成自己。
 *
 * 元链的流程：
 *
 *   chain.start
 *      │
 *   [spec] ──spec.invalid──> [bail] (halt)
 *      │ spec.ready
 *   [blueprint]  ← 唯一需要「设计判断」的地方，交给模型
 *      │ blueprint.ready
 *   [scaffold]   ← 确定性编译，模型不碰骨架
 *      │ scaffold.done
 *   [lint] <───────────────┐
 *      │ lint.fail          │ patch.applied
 *      ↓                    │
 *   [repair] → [applyPatch]─┘        (三处 maxRuns 刹车)
 *      │ lint.pass
 *      ↓
 *   [dryRun]  ← 用 mock 模型真跑一遍，验证能终止
 *      │
 *   [verdict] ──reject──> [report] (halt)
 *      │ approve
 *   [write] ──> [report] (halt)
 */

const { ROLES, buildPrompt, HARD_RULES, schemaToText } = require('./templates');

function buildGenesisChain() {
  const architect = ROLES['chain-architect'];
  const fixer = ROLES['chain-fixer'];

  /* ---------------- blueprint 节点的提示词 ---------------- */
  const blueprintSystem = [
    HARD_RULES,
    '',
    '【你的角色】chain-architect（触发链架构师）',
    `【你的职责】${architect.duty}`,
    '',
    '【什么是触发链】',
    '一条链由若干节点组成。节点不被主动调用，而是订阅事件被唤醒；节点执行后发出信号，信号唤醒下游节点。',
    '你现在只需要设计「阶段序列」：有哪几个阶段、每个阶段用什么角色、各自要产出什么。',
    '触发器接线、入口归一化、质量门、迭代刹车、终止节点这些骨架，由编译器自动生成，你不要操心，也不要输出。',
    '',
    '【设计准则】',
    '  1. 阶段数控制在 3-7 个。少于 3 个通常说明没有真正分解，多于 7 个通常是过度设计。',
    '  2. 每个阶段必须有**可被校验的产出**。说不清产出什么的阶段，就不该存在。',
    '  3. 相邻阶段之间要有真实的信息增量。只是"换个说法重复一遍"的阶段要合并掉。',
    '  4. 优先复用【可用角色】里的角色，它们自带经过打磨的提示词模板与输出契约。',
    '  5. 如果【已有链】里已经有 intent 高度重合的链，在 issues 里指出来，建议复用或合并而不是新建——避免无限新增。',
    '  6. 每个阶段都要可被逐步反馈：节点执行后应通过信号与追踪器暴露本步的操作与产出，整条链的运行过程可被逐步复盘，不能是黑箱。',
    '  7. 版本号遵循三段式 v主.次.修：每个新链初始为 v0.0.1（原型稿/测试版）；第一位 MAJOR 在发生「大版本更新」(不兼容变更、删/改名节点 id、改信号协议或 envelope 契约结构)时升 1 并归零后两位；第二位 MINOR 在新增或更新某个「模块」(节点/角色/子能力/整段逻辑)时升 1 并归零 PATCH；第三位 PATCH 在小需求变动(文案/调参/字段微调/单节点局部改动/小 bug 修复)时升 1。绝不要无脑升 MAJOR。',
    '  8. （推荐范式）遵循「带AI打仗」四层模型：战略层（intent/principle/acceptance）由人定方向；建制层（nodes/budget/expect/版本号）是制度；战术层（llm/fn/gate/map/loop）由AI执行；裁决层（lint五门/review/test-executor/deliver完成包）由机器裁定。',
    '  9. （推荐范式）deliver 节点尽量输出完成包（completionPackage）：变更范围、设计说明、风险、验收命令、原始验证结果、回归/兼容说明、未完成事项、下一步建议。',
    '',
    '【输出契约 data 必须满足】',
    schemaToText(architect.expect),
    '',
    '【可用信号】blueprint.ready',
  ].join('\n');

  const blueprintUser = [
    '【建链需求】',
    '{{$.spec.goal}}',
    '',
    '【领域】{{$.spec.domain}}',
    '【期望阶段数】{{$.spec.expectedStages}}（为空表示由你决定）',
    '【额外约束】',
    '{{$.spec.constraints}}',
    '【验收条件】',
    '{{$.spec.acceptance}}',
    '',
    '【可用角色（强烈建议从中选择）】',
    '{{$.spec.availableRoles}}',
    '',
    '【本系统已有的链（避免重复造）】',
    '{{$.spec.existingChains}}',
    '',
    '现在输出蓝图 JSON 信封。stages 里每一项只要 id / role / title / intent / produces 五个字段。',
  ].join('\n');

  /* ---------------- repair 节点的提示词 ---------------- */
  const repairSystem = [
    HARD_RULES,
    '',
    '【你的角色】chain-fixer（链修复器）',
    `【你的职责】${fixer.duty}`,
    '',
    '【补丁路径语法】',
    '  nodes.<节点id>.<字段>      按节点 id 定位，例如 nodes.review.maxRuns',
    '  nodes.<节点id>.prompt.user 支持多级路径',
    '  $.budget.maxLlmCalls       链级字段用 $. 开头',
    '',
    '【补丁操作】set 覆盖 / merge 浅合并对象 / push 追加到数组 / remove 删除',
    '',
    '【常见 linter 规则与标准修法】',
    '  L003 缺必备字段     → set 补上该字段',
    '  L004 孤儿节点       → 通常是上游 declares 漏了信号：push 到上游节点的 declares；或改本节点 trigger',
    '  L005 悬空信号       → 一般可忽略（info）',
    '  L006 无终止路径     → 给终点节点 set halt=true，或补一个 fn:deliver 节点',
    '  L007 无刹车环路     → 给环上节点 set maxRuns（建议 2-5）',
    '  L008 幽灵依赖       → 修正引用路径，或给上游节点 set out 到该路径',
    '  L009 缺输出契约     → set expect 为一个 JSON Schema 对象',
    '  L010 预算不足       → set $.budget.maxLlmCalls 为 llm 节点数的 2-3 倍',
    '',
    '【铁律】只修 linter 明确报出的 error 与 warn，不要顺手重构。改不了的放进 unfixable 并说明原因。',
    '',
    '【输出契约 data 必须满足】',
    schemaToText(fixer.expect),
    '',
    '【可用信号】repair.ready / repair.impossible',
  ].join('\n');

  const repairUser = [
    '【第 {{$.lint.round}} 轮检查报告】',
    '错误 {{$.lint.summary.errors}} 条，警告 {{$.lint.summary.warnings}} 条，评分 {{$.lint.score}}',
    '',
    '【需要修复的问题】',
    '{{$.lint.findings}}',
    '',
    '【当前链的节点摘要】',
    '{{pluck($.draft.chain.nodes, "id")}}',
    '',
    '【当前链定义】',
    '{{$.draft.chain}}',
    '',
    '现在输出补丁 JSON 信封。每条补丁必须带 rule 字段指明它修的是哪条规则。',
  ].join('\n');

  return {
    id: 'sys.genesis',
    title: '元链 · 生成并初始化其他触发链',
    version: '1.1.0',
    intent: '接收一句自然语言的建链需求，产出一条结构合法、可达、可终止、已通过空跑验证的新触发链，并落盘注册。',
    principle: [
      '骨架由代码生成，语义由模型生成——模型最容易写错的地方一律不交给模型。',
      '任何生成物在落盘前必须通过静态检查 + 空跑双重验证，不合格就打回重修。',
      '修复循环必须有刹车：三处 maxRuns 保证元链自身永远不会跑飞。',
      '生成失败也要产出报告，说明卡在哪一步，而不是静默失败。',
      '生成的每一条子链都必须自带逐步反馈能力（信号 + 追踪），运行过程可被逐步复盘。',
    ],
    acceptance: [
      '产出的链能通过 linter（0 个 error）',
      '产出的链能在 mock 模型下自然终止而非被预算熔断',
      '无论成功失败都产出一份可读的建链报告',
    ],
    budget: {
      maxSteps: 300,
      maxLlmCalls: 24,
      maxTokens: 300000,
      maxWallMs: 240000,
      maxNodeRuns: 8,
    },
    nodes: [
      /* ---------- 1. 需求规格化 ---------- */
      {
        id: 'spec',
        kind: 'fn',
        title: '建链需求规格化',
        use: 'genesis.spec',
        trigger: [{ on: 'chain.start' }],
        in: { raw: '$.input' },
        out: '$.spec',
        declares: ['spec.ready', 'spec.invalid'],
      },

      /* ---------- 2. 早退 ---------- */
      {
        id: 'bail',
        kind: 'fn',
        title: '需求不合法，提前终止',
        use: 'deliver',
        trigger: [{ on: 'signal.spec.invalid' }],
        in: { answer: null, quality: { aborted: true, reason: '建链需求缺少目标描述' } },
        out: '$.output',
        halt: true,
        declares: ['chain.end'],
      },

      /* ---------- 3. 蓝图设计（唯一的设计判断） ---------- */
      {
        id: 'blueprint',
        kind: 'llm',
        title: '设计链蓝图',
        role: 'chain-architect',
        trigger: [{ on: 'signal.spec.ready' }],
        prompt: { system: blueprintSystem, user: blueprintUser },
        expect: architect.expect,
        temperature: 0.3,
        retry: { max: 2, onExhausted: 'throw' },
        out: '$.blueprint',
        emit: ['blueprint.ready'],
        declares: ['blueprint.ready'],
        maxRuns: 3,
      },

      /* ---------- 4. 确定性编译 ---------- */
      {
        id: 'scaffold',
        kind: 'fn',
        title: '蓝图编译为链定义',
        use: 'genesis.scaffold',
        trigger: [{ on: 'signal.blueprint.ready' }],
        in: { blueprint: '$.blueprint', spec: '$.spec' },
        out: '$.draft',
        declares: ['scaffold.done'],
      },

      /* ---------- 5. 静态检查 ---------- */
      {
        id: 'lint',
        kind: 'fn',
        title: '链定义静态检查',
        use: 'genesis.lint',
        trigger: [{ on: 'signal.scaffold.done' }, { on: 'signal.patch.applied' }],
        in: { chain: '$.draft.chain' },
        out: '$.lint',
        maxRuns: 5,
        declares: ['lint.pass', 'lint.fail'],
      },

      /* ---------- 6. 修复回路 ---------- */
      {
        id: 'repair',
        kind: 'llm',
        title: '按检查报告生成补丁',
        role: 'chain-fixer',
        trigger: [{ on: 'signal.lint.fail' }],
        prompt: { system: repairSystem, user: repairUser },
        expect: fixer.expect,
        temperature: 0.1,
        retry: { max: 1, onExhausted: 'passthrough' },
        out: '$.repair',
        emit: ['repair.ready'],
        declares: ['repair.ready'],
        maxRuns: 3,
      },
      {
        id: 'applyPatch',
        kind: 'fn',
        title: '应用补丁',
        use: 'genesis.applyPatch',
        trigger: [{ on: 'signal.repair.ready' }],
        in: { chain: '$.draft.chain', patches: '$.repair.patches' },
        out: '$.patchResult',
        maxRuns: 3,
        declares: ['patch.applied'],
      },

      /* ---------- 7. 空跑验证 ---------- */
      {
        id: 'dryRun',
        kind: 'fn',
        title: 'mock 空跑验证',
        use: 'genesis.dryRun',
        trigger: [{ on: 'signal.lint.pass' }],
        in: { chain: '$.draft.chain' },
        out: '$.dryrun',
        declares: ['dryrun.ok', 'dryrun.fail'],
      },

      /* ---------- 8. 裁决 ---------- */
      {
        id: 'verdict',
        kind: 'gate',
        title: '是否准予落盘',
        trigger: [{ on: 'signal.dryrun.ok' }, { on: 'signal.dryrun.fail' }],
        cases: [
          { when: '$.lint.ok && $.dryrun.ok', emit: 'genesis.approve', label: '通过', reason: '静态检查与空跑均通过' },
          { when: '$.lint.ok && !$.dryrun.ok', emit: 'genesis.reject', label: '空跑失败', reason: '结构合法但跑不通' },
        ],
        default: 'genesis.reject',
        declares: ['genesis.approve', 'genesis.reject'],
      },

      /* ---------- 9. 落盘 ---------- */
      {
        id: 'write',
        kind: 'fn',
        title: '写入 chains/ 并注册',
        use: 'genesis.write',
        trigger: [{ on: 'signal.genesis.approve' }],
        in: { chain: '$.draft.chain' },
        out: '$.written',
        declares: ['write.done'],
      },

      /* ---------- 10. 报告 ---------- */
      {
        id: 'report',
        kind: 'fn',
        title: '产出建链报告',
        use: 'genesis.report',
        trigger: [{ on: 'signal.write.done' }, { on: 'signal.genesis.reject' }],
        in: { approved: '$.written.written' },
        out: '$.output',
        halt: true,
        declares: ['genesis.done', 'chain.end'],
      },
    ],
  };
}

module.exports = { buildGenesisChain };
