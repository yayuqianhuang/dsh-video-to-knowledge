'use strict';
/**
 * genesis/functions.js —— 元链专用函数节点
 *
 * 元链 sys.genesis 的骨架动作全部在这里，全部是确定性代码：
 *   genesis.spec       把用户的自然语言需求规格化成建链规格
 *   genesis.scaffold   蓝图 → 链定义（编译）
 *   genesis.lint       静态检查
 *   genesis.applyPatch 应用修复补丁
 *   genesis.dryRun     用 mock 模型空跑一遍，验证真的能跑通并终止
 *   genesis.write      落盘并注册
 *   genesis.report     产出建链报告
 *
 * 交给模型的只有两件事：设计蓝图、根据 linter 报告写补丁。
 */

const path = require('path');
const { scaffold, applyPatches, slug } = require('./scaffold');
const { lint, formatFindings } = require('./lint');
const { ROLES } = require('./templates');

function genesisFns({ registry, adapterFactory } = {}) {
  return {
    /* ------------------------------------------------------------ */
    'genesis.spec': (args, ctx) => {
      const raw = args.raw ?? ctx.bb.get('$.input') ?? {};
      const goal = String(raw.goal || raw.task || (typeof raw === 'string' ? raw : '') || '').trim();

      const spec = {
        goal,
        chainId: raw.chainId || null,
        domain: raw.domain || 'general',
        expectedStages: Number(raw.stages) || null,
        qualityGate: raw.qualityGate !== false,
        iterate: raw.iterate || { maxRounds: 2, target: 0.85 },
        constraints: Array.isArray(raw.constraints) ? raw.constraints : [],
        acceptance: Array.isArray(raw.acceptance) ? raw.acceptance : [],
        availableRoles: Object.keys(ROLES).filter((r) => r !== 'generic'),
        existingChains: registry ? registry.index() : [],
        createdAt: new Date().toISOString(),
      };

      const issues = [];
      if (!goal) issues.push({ severity: 'critical', where: '$.input.goal', msg: '没有说明要造一条什么链，无法继续' });
      else if (goal.length < 6) issues.push({ severity: 'medium', where: '$.input.goal', msg: '目标描述过短，蓝图质量可能很差' });

      if (spec.chainId && registry && registry.has(spec.chainId)) {
        issues.push({ severity: 'high', where: '$.input.chainId', msg: `链 id "${spec.chainId}" 已存在，将会覆盖` });
      }

      return {
        data: spec,
        issues,
        signals: goal ? ['spec.ready'] : ['spec.invalid'],
      };
    },

    /* ------------------------------------------------------------ */
    'genesis.scaffold': (args, ctx) => {
      const bp = args.blueprint || ctx.bb.get('$.blueprint') || {};
      const spec = args.spec || ctx.bb.get('$.spec') || {};
      const merged = {
        ...bp,
        chainId: spec.chainId || bp.chainId,
        qualityGate: bp.qualityGate !== undefined ? bp.qualityGate : spec.qualityGate,
        iterate: bp.iterate || spec.iterate,
        acceptance: (bp.acceptance && bp.acceptance.length) ? bp.acceptance : spec.acceptance,
      };
      const { chain, notes } = scaffold(merged, {});
      for (const n of notes) ctx.tracer.warn('scaffold.note', n, { node: ctx.node.id });
      return {
        data: { chain, notes, nodeCount: chain.nodes.length },
        issues: notes.map((n) => ({ severity: 'low', where: 'scaffold', msg: n })),
        signals: ['scaffold.done'],
      };
    },

    /* ------------------------------------------------------------ */
    'genesis.lint': (args, ctx) => {
      const chain = args.chain || ctx.bb.get('$.draft.chain');
      if (!chain) return { data: { ok: false, findings: [] }, issues: [{ severity: 'critical', where: 'lint', msg: '没有待检查的链' }], signals: ['lint.fail'] };

      const knownFns = Object.keys(ctx.kernel ? ctx.kernel.fns : {}).filter((k) => !k.startsWith('genesis.'));
      const res = lint(chain, {
        knownFns: knownFns.length ? knownFns : undefined,
        knownChains: registry ? registry.ids() : undefined,
      });

      const round = Number(ctx.bb.get('$._lintRound', 0)) + 1;
      ctx.bb.set('$._lintRound', round);

      ctx.tracer[res.ok ? 'info' : 'warn'](
        'lint.result',
        `第 ${round} 轮检查：${res.ok ? '通过' : '未通过'} · ${res.summary.errors} 错 / ${res.summary.warnings} 警 / ${res.summary.infos} 提示 · 评分 ${res.score}`,
        { node: ctx.node.id },
      );
      if (res.findings.length) ctx.tracer.debug('lint.detail', '\n' + formatFindings(res), { node: ctx.node.id });

      return {
        data: { ...res, round },
        issues: res.findings.filter((f) => f.level === 'error').map((f) => ({ severity: 'high', where: f.where, msg: `[${f.rule}] ${f.msg}` })),
        signals: res.ok ? ['lint.pass'] : ['lint.fail'],
      };
    },

    /* ------------------------------------------------------------ */
    'genesis.applyPatch': (args, ctx) => {
      const chain = args.chain || ctx.bb.get('$.draft.chain');
      const patches = args.patches || ctx.bb.get('$.repair.patches') || [];
      const { chain: next, applied, failed } = applyPatches(chain, patches);
      ctx.bb.set('$.draft.chain', next);
      ctx.tracer.info('patch.apply', `应用 ${applied.length} 条补丁，失败 ${failed.length} 条`, { node: ctx.node.id });
      return {
        data: { chain: next, applied, failed, appliedCount: applied.length },
        issues: failed.map((f) => ({ severity: 'medium', where: f.path, msg: `补丁未应用：${f.error}` })),
        signals: ['patch.applied'],
      };
    },

    /* ------------------------------------------------------------ */
    'genesis.dryRun': async (args, ctx) => {
      const chain = args.chain || ctx.bb.get('$.draft.chain');
      const { Kernel } = require('../engine/kernel');
      const { MockAdapter } = require('../adapters/mock');
      const { Tracer } = require('../engine/tracer');

      const subTracer = new Tracer({ level: 'error', silent: true, runId: `dry_${Date.now().toString(36)}` });
      const kernel = new Kernel({
        chain,
        adapter: (adapterFactory ? adapterFactory() : new MockAdapter()),
        tracer: subTracer,
        loadChain: registry ? registry.loader() : undefined,
        budget: { maxSteps: 150, maxLlmCalls: 30, maxTokens: 150000, maxWallMs: 20000, maxNodeRuns: 8 },
      });

      let result, crash = null;
      try {
        result = await kernel.run(args.sample || {
          goal: `空跑验证：${chain.title}`,
          context: '这是 genesis 自动生成的冒烟样本',
          constraints: ['离线运行'],
          acceptance: ['链能自然终止'],
        });
      } catch (e) {
        crash = e.message;
      }

      const executed = new Set(Object.keys(result?.envelopes || {}));
      const never = (chain.nodes || []).map((n) => n.id).filter((id) => !executed.has(id));
      const naturalEnd = !!result && /chain\.end|声明终止/.test(result.haltReason || '');
      const stats = subTracer.stats();

      const ok = !crash && naturalEnd && stats.errors.length === 0;
      const issues = [];
      if (crash) issues.push({ severity: 'critical', where: 'dryRun', msg: `空跑抛异常：${crash}` });
      if (!crash && !naturalEnd) issues.push({ severity: 'critical', where: 'dryRun', msg: `链没有自然终止，终止原因：${result?.haltReason || '事件队列耗尽'}` });
      for (const e of stats.errors.slice(0, 5)) issues.push({ severity: 'high', where: 'dryRun', msg: `${e.type}: ${e.msg}` });
      // 只在有分支的链里，未执行节点才可能是正常的
      if (never.length) issues.push({ severity: 'low', where: 'dryRun', msg: `本次空跑未走到的节点：${never.join(', ')}（若为异常分支属正常）` });

      ctx.tracer[ok ? 'info' : 'warn']('dryrun.result',
        `空跑${ok ? '通过' : '未通过'} · 执行 ${executed.size}/${(chain.nodes || []).length} 节点 · ${result?.budget?.used?.steps || 0} 步 · ${result?.budget?.used?.llmCalls || 0} 次模型调用 · ${result?.haltReason || crash}`,
        { node: ctx.node.id });

      return {
        data: {
          ok,
          crash,
          naturalEnd,
          haltReason: result?.haltReason || null,
          executedNodes: [...executed],
          neverExecuted: never,
          steps: result?.budget?.used?.steps || 0,
          llmCalls: result?.budget?.used?.llmCalls || 0,
          elapsedMs: result?.budget?.used?.elapsedMs || 0,
          runtimeErrors: stats.errors,
          output: result?.blackboard?.output ?? null,
        },
        issues,
        signals: ok ? ['dryrun.ok'] : ['dryrun.fail'],
      };
    },

    /* ------------------------------------------------------------ */
    'genesis.write': (args, ctx) => {
      const chain = args.chain || ctx.bb.get('$.draft.chain');
      if (!registry) return { data: { written: false, reason: '未挂载 registry' }, signals: ['write.skipped'] };
      const file = registry.save(chain);
      ctx.tracer.info('genesis.write', `已写入 ${path.basename(file)}`, { node: ctx.node.id });
      return {
        data: { written: true, file, chainId: chain.id, nodes: chain.nodes.length },
        signals: ['write.done'],
      };
    },

    /* ------------------------------------------------------------ */
    'genesis.report': (args, ctx) => {
      const chain = ctx.bb.get('$.draft.chain') || {};
      const lintRes = ctx.bb.get('$.lint') || {};
      const dry = ctx.bb.get('$.dryrun') || {};
      const write = ctx.bb.get('$.written') || {};
      const spec = ctx.bb.get('$.spec') || {};
      const approved = args.approved !== false && !!write.written;

      const report = {
        approved,
        chainId: chain.id,
        title: chain.title,
        intent: chain.intent,
        file: write.file || null,
        nodes: (chain.nodes || []).map((n) => ({
          id: n.id, kind: n.kind, role: n.role || null,
          on: (n.trigger || []).map((t) => t.on),
          declares: n.declares || [],
        })),
        lint: {
          passed: !!lintRes.ok,
          score: lintRes.score ?? null,
          rounds: lintRes.round ?? null,
          summary: lintRes.summary || {},
          remaining: (lintRes.findings || []).filter((f) => f.level !== 'info'),
        },
        dryRun: {
          passed: !!dry.ok,
          steps: dry.steps || 0,
          llmCalls: dry.llmCalls || 0,
          haltReason: dry.haltReason || null,
          neverExecuted: dry.neverExecuted || [],
        },
        request: { goal: spec.goal, domain: spec.domain },
        nextActions: [],
        finishedAt: new Date().toISOString(),
      };

      if (!lintRes.ok) report.nextActions.push('linter 仍有 error，需人工确认后再启用');
      if (!dry.ok) report.nextActions.push('空跑未通过，先用 ajtc lint / run 复现问题');
      if (approved) report.nextActions.push(`用 node src/cli.js run ${chain.id} --input <file> 真实运行`);
      report.nextActions.push(`用 node src/cli.js viz ${chain.id} 查看链路图`);

      /* 完成包：两层军报分离。
       * 叙述层是给人读的判断，证据层是机器算出来的数——
       * 混在一起写，读的人分不清哪句话有据可查，那治理就退回成「AI 说它干完了」。 */
      const ev = ctx.bb.get('$.evidence') || {};
      const as = ctx.bb.get('$.assert') || {};
      report.completionPackage = {
        scope: '从自然语言需求编译出一条结构合法、可终止的 JSON 触发链',
        changeScope: approved
          ? `新增链定义 ${chain.id}（${(chain.nodes || []).length} 节点），落盘于 ${write.file || '(未记录路径)'}`
          : `未落盘：链 ${chain.id || '(未命名)'} 未通过裁决，chains/ 目录无变更`,
        designRationale: '骨架（触发器接线 / intake / 终止节点 / 迭代刹车 / 四层治理基线）由确定性代码生成，模型只贡献阶段序列与角色语义——模型最容易写错的部分不交给模型。',
        risks: (lintRes.findings || []).filter((f) => f.level !== 'info').map((f) => `${f.rule} ${f.msg}`),
        acceptanceCommand: chain.id ? `node src/cli.js lint ${chain.id} && node src/cli.js run ${chain.id} --goal "<目标>" --mock` : null,
        verificationResults: {
          lint: { passed: !!lintRes.ok, score: lintRes.score ?? null, rounds: lintRes.round ?? null },
          dryRun: { passed: !!dry.ok, steps: dry.steps || 0, llmCalls: dry.llmCalls || 0, neverExecuted: dry.neverExecuted || [] },
          governance: (lintRes.gates && lintRes.gates.governance) ? { passed: lintRes.gates.governance.passed, score: lintRes.gates.governance.score } : null,
        },
        regressionCompatibility: `新建链自带 ${(chain.regressionTests || []).length} 条回归用例；本次不改动任何既有链，链仓其余部分不受影响。`,
        issuesAndMethods: as.issues || (lintRes.findings || []).filter((f) => f.level === 'error'),
        openItems: (lintRes.findings || []).filter((f) => f.level === 'warn').map((f) => `${f.rule} ${f.msg}`),
        nextSteps: report.nextActions,
        artifactsHash: ev.hashes || null,
        narrative: {
          layer: '叙述层（AI 写给人看）',
          note: '供人快速决策，不作为验收依据。',
          summary: approved
            ? `已生成并落盘链 ${chain.id}：${(chain.nodes || []).length} 个节点，lint ${lintRes.score ?? '?'} 分，空跑${dry.ok ? '通过' : '未过'}。可直接用 run 命令试跑。`
            : `链 ${chain.id || '(未命名)'} 未通过裁决门，未落盘。主因见 issuesAndMethods，修完重跑 sys.genesis 即可。`,
        },
        evidence: {
          layer: '证据层（机器统计，不可编造）',
          note: '以下全部由 fn 节点确定性生成，模型无法改写；验收以本层为准。',
          runId: ev.runId || (ctx.tracer && ctx.tracer.runId) || null,
          lintScore: lintRes.score ?? null,
          dryRunSteps: dry.steps || 0,
          nodeCount: (chain.nodes || []).length,
          written: !!write.written,
          file: write.file || null,
          hashes: ev.hashes || null,
          assertions: as.passed != null ? { passed: as.passed, total: as.total, failed: as.failedCount } : null,
        },
      };

      ctx.tracer.info('genesis.report', `建链${approved ? '成功' : '未通过'}：${chain.id}（${(chain.nodes || []).length} 节点）`, { node: ctx.node.id });
      return { data: report, signals: ['genesis.done', 'chain.end'] };
    },
  };
}

module.exports = { genesisFns };
