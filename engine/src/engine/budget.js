'use strict';
/**
 * budget.js —— 预算与熔断
 *
 * 触发链最大的风险是「自我迭代」类链条无限自我调用。
 * 这里把 步数 / LLM 调用数 / token / 墙钟时间 / 单节点重入次数 全部纳入硬约束，
 * 逼近阈值时发出 budget.low 信号，超限时发出 budget.exceeded 并强制收敛。
 */

class Budget {
  constructor(opts = {}) {
    this.limits = {
      maxSteps: opts.maxSteps ?? 400,
      maxLlmCalls: opts.maxLlmCalls ?? 120,
      maxTokens: opts.maxTokens ?? 400000,
      maxWallMs: opts.maxWallMs ?? 5 * 60 * 1000,
      maxNodeRuns: opts.maxNodeRuns ?? 12,
      warnRatio: opts.warnRatio ?? 0.8,
    };
    this.used = { steps: 0, llmCalls: 0, tokens: 0 };
    this.t0 = Date.now();
    this._warned = false;
  }

  get elapsedMs() { return Date.now() - this.t0; }

  tick(kind, n = 1) {
    if (kind === 'step') this.used.steps += n;
    if (kind === 'llm') this.used.llmCalls += n;
    if (kind === 'token') this.used.tokens += n;
  }

  /** @returns {null | {level:'warn'|'exceed', reason:string}} */
  check() {
    const L = this.limits, U = this.used;
    const over = [];
    if (U.steps > L.maxSteps) over.push(`步数 ${U.steps}/${L.maxSteps}`);
    if (U.llmCalls > L.maxLlmCalls) over.push(`LLM 调用 ${U.llmCalls}/${L.maxLlmCalls}`);
    if (U.tokens > L.maxTokens) over.push(`token ${U.tokens}/${L.maxTokens}`);
    if (this.elapsedMs > L.maxWallMs) over.push(`耗时 ${this.elapsedMs}ms/${L.maxWallMs}ms`);
    if (over.length) return { level: 'exceed', reason: over.join('，') };

    const ratios = [U.steps / L.maxSteps, U.llmCalls / L.maxLlmCalls, U.tokens / L.maxTokens, this.elapsedMs / L.maxWallMs];
    if (!this._warned && Math.max(...ratios) >= L.warnRatio) {
      this._warned = true;
      return { level: 'warn', reason: `预算已用 ${(Math.max(...ratios) * 100).toFixed(0)}%，建议开始收敛` };
    }
    return null;
  }

  report() {
    return {
      used: { ...this.used, elapsedMs: this.elapsedMs },
      limits: this.limits,
      usage: {
        steps: +(this.used.steps / this.limits.maxSteps).toFixed(3),
        llmCalls: +(this.used.llmCalls / this.limits.maxLlmCalls).toFixed(3),
        tokens: +(this.used.tokens / this.limits.maxTokens).toFixed(3),
      },
    };
  }
}

/** 粗略 token 估算：中文按 1.6 字/token，英文按 4 字符/token */
function estimateTokens(text) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || '');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.6 + rest / 4);
}

module.exports = { Budget, estimateTokens };
