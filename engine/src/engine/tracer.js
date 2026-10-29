'use strict';
/**
 * tracer.js —— 全链路追踪
 * 每一次事件、每一次节点执行、每一次 JSON 修复与校验失败都会被记录。
 * 这是「自我梳理 / 自我找 bug」链的原料来源。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };

class Tracer {
  constructor({ level = 'info', silent = false, runId } = {}) {
    this.level = LEVELS[level] || 20;
    this.silent = silent;
    this.runId = runId || `run_${Date.now().toString(36)}`;
    this.records = [];
    this.t0 = Date.now();
  }

  log(level, type, msg, extra) {
    const rec = { seq: this.records.length + 1, t: Date.now() - this.t0, level, type, msg, ...(extra ? { extra } : {}) };
    this.records.push(rec);
    if (!this.silent && LEVELS[level] >= this.level) {
      const pad = String(rec.seq).padStart(3, ' ');
      const c = COLOR[level] || '';
      // eslint-disable-next-line no-console
      console.log(`${c}[${pad}] ${String(rec.t).padStart(5)}ms ${type.padEnd(14)}${COLOR.reset} ${msg}`);
    }
    return rec;
  }

  debug(t, m, e) { return this.log('debug', t, m, e); }
  info(t, m, e) { return this.log('info', t, m, e); }
  warn(t, m, e) { return this.log('warn', t, m, e); }
  error(t, m, e) { return this.log('error', t, m, e); }

  /** 统计视图：给「自我梳理」链消费 */
  stats() {
    const byType = {};
    const byNode = {};
    for (const r of this.records) {
      byType[r.type] = (byType[r.type] || 0) + 1;
      const nid = r.extra && r.extra.node;
      if (nid) {
        byNode[nid] = byNode[nid] || { runs: 0, fails: 0, repairs: 0, ms: 0 };
        if (r.type === 'node.done') { byNode[nid].runs++; byNode[nid].ms += (r.extra.ms || 0); }
        if (r.type === 'node.fail') byNode[nid].fails++;
        if (r.type === 'json.repair') byNode[nid].repairs++;
      }
    }
    return {
      runId: this.runId,
      totalRecords: this.records.length,
      elapsedMs: Date.now() - this.t0,
      byType,
      byNode,
      errors: this.records.filter((r) => r.level === 'error').map((r) => ({ type: r.type, msg: r.msg })),
      warnings: this.records.filter((r) => r.level === 'warn').map((r) => ({ type: r.type, msg: r.msg })),
    };
  }

  toJSON() { return { runId: this.runId, records: this.records, stats: this.stats() }; }
}

module.exports = { Tracer };
