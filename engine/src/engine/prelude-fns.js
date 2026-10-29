'use strict';
/**
 * prelude-fns.js —— 基础前置链 sys.prelude 的确定性函数节点
 *
 * 基础前置链在每条链正式运行前自动先跑（由 kernel.runPrelude 触发），
 * 承担：录制输入快照（影子回放）、轻量治理前置断言、产出前置完成包。
 * 全部 fn 节点、零 LLM、零副作用、非致命。
 *
 * 约定（与 execFn 对齐）：fn 签名为 (args, ctx)，ctx.bb 是 Blackboard 实例（有 .get）。
 * 主链信息通过 runPrelude 注入的 $.targetChain / $.preludeRunId 读取，避免递归自指。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
// [vendored-patch] 允许安装到只读 node_modules 时把 run-shadow 录制重定向到可写目录
const SHADOW_DIR = process.env.AJTC_SHADOW_DIR ? path.resolve(process.env.AJTC_SHADOW_DIR) : path.join(ROOT, 'run-shadow');

function preludeFns({ registry, fns } = {}) {
  const mounted = fns || {};
  return {
    /* 录制输入信封 + 黑板初态快照（影子回放录制层），落盘到 run-shadow/ */
    'prelude.snapshot': (args, ctx) => {
      const target = ctx.bb.get('$.targetChain') || {};
      const meta = ctx.bb.get('$._meta') || {};
      const runId = ctx.bb.get('$.preludeRunId') || meta.runId || crypto.randomBytes(8).toString('hex');
      const bbData = ctx.bb.data || {};
      const blackboardInit = {};
      for (const k of Object.keys(bbData)) {
        if (k === 'targetChain' || k === 'preludeRunId') continue; // 不搬运主链完整对象/内部标记
        const v = bbData[k];
        if (typeof v === 'object' && v !== null) {
          blackboardInit[k] = Array.isArray(v) ? `[array ${v.length}]` : `{obj ${Object.keys(v).length} keys}`;
        } else {
          blackboardInit[k] = v;
        }
      }
      const targetNodes = target.nodes || [];
      const sideEffects = targetNodes
        .filter((n) => n && n.sideEffect === true && n.use)
        .map((n) => n.use);
      const rec = {
        chainId: target.id || meta.chain || (ctx.chain && ctx.chain.id),
        runId,
        recordedAt: new Date().toISOString(),
        input: ctx.bb.get('$.input'),
        blackboardInit,
        meta: { traceparent: meta.traceparent || null },
        sideEffects,
        recordedWith: 'sys.prelude.snapshot',
      };
      let file = null;
      try {
        const dir = path.join(SHADOW_DIR, rec.chainId || 'unknown');
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, `${runId}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
      } catch (e) {
        // 录制落盘失败非致命，但记录以便排查
        if (ctx && ctx.tracer && typeof ctx.tracer.error === 'function') {
          ctx.tracer.error('prelude.snapshot.write', `录制落盘失败: ${e.message}`);
        }
      }
      return {
        data: { snapshot: rec, file: file ? path.relative(ROOT, file) : null },
        signals: ['prelude.snapshot'],
      };
    },

    /* 轻量治理前置断言：版本号合法、主链依赖 fn 已挂载 */
    'prelude.govern': (args, ctx) => {
      const issues = [];
      const target = ctx.bb.get('$.targetChain') || ctx.chain || {};
      if (target.version && !/^v?\d+\.\d+\.\d+$/.test(String(target.version))) {
        issues.push({ severity: 'medium', where: 'chain.version', msg: `版本号 "${target.version}" 不符合 v主.次.修 规则` });
      }
      const missing = [];
      for (const n of (target.nodes || [])) {
        if (n.kind === 'fn' && n.use && !mounted[n.use]) missing.push(n.use);
      }
      if (missing.length) {
        issues.push({ severity: 'high', where: 'chain.nodes', msg: `主链引用了未挂载的 fn: ${missing.join(', ')}` });
      }
      return {
        data: { govern: { ok: issues.length === 0, target: target.id || (ctx.chain && ctx.chain.id), issues } },
        issues,
        signals: ['prelude.govern'],
      };
    },

    /* 汇总前置完成包到 $.prelude（主链 runPrelude 会合并回主黑板） */
    'prelude.done': (args, ctx) => {
      const snap = ctx.bb.get('$.prelude.snapshot');
      const gov = ctx.bb.get('$.prelude.govern');
      const snapData = snap ? (snap.snapshot || snap.data || snap) : null;
      const govData = gov ? (gov.govern || gov.data || gov) : null;
      return {
        data: {
          snapshot: snapData,
          govern: govData,
          ok: govData ? govData.ok !== false : true,
        },
        signals: ['prelude.done'],
      };
    },
  };
}

module.exports = { preludeFns };
