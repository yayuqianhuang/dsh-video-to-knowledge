'use strict';
/**
 * mock.js —— 离线确定性模型适配器（通用版，不含任何项目专属内容）
 *
 * 设计目标：
 *   1. 让整套触发链**不依赖任何 API Key 就能完整跑通**，方便理解与调试链路骨架。
 *   2. 根据节点声明的 JSON Schema（node.expect）确定性地合成符合契约的数据，
 *      从而真实演练「调度 → 执行 → 信号驱动」闭环，而不依赖真实 LLM。
 *   3. 提供故障注入（坏 JSON / 契约不符 / 抛错），用来验证内核的修复与熔断能力。
 *
 * 本适配器刻意不含任何业务/项目专属的硬编码角色内容；它只根据 schema 与
 * 确定性种子合成数据，保证「任意链都能在离线 mock 下跑通」。
 */

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

function pick(arr, seed) { return arr[seed % arr.length]; }

/**
 * 从一个 JSON Schema 确定性地合成一个合法实例。
 * 失败时回退到极简对象，保证内核 repair/coerce 阶段仍能处理。
 */
function synthFromSchema(schema, seed) {
  if (!schema || typeof schema !== 'object') return { ok: true, mock: true };
  const type = schema.type
    || (schema.properties ? 'object'
      : (schema.items ? 'array' : 'string'));
  switch (type) {
    case 'object': {
      const out = {};
      const props = schema.properties || {};
      const required = Array.isArray(schema.required) && schema.required.length
        ? schema.required
        : Object.keys(props);
      for (const k of required) out[k] = synthFromSchema(props[k], hash(`${seed}:${k}`));
      return out;
    }
    case 'array': {
      const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      const n = (seed % 3) + 1;
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(synthFromSchema(itemSchema, hash(`${seed}:${i}`)));
      return arr;
    }
    case 'integer':
      return (seed % 100);
    case 'number':
      return +((seed % 100) + 0.5).toFixed(2);
    case 'boolean':
      return (seed % 2) === 0;
    case 'string':
    default:
      if (Array.isArray(schema.enum) && schema.enum.length) return pick(schema.enum, seed);
      if (schema.const !== undefined) return schema.const;
      if (schema.format === 'date-time') return new Date(Date.now()).toISOString();
      return `mock-${seed.toString(36)}`;
  }
}

class MockAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.faults  { [nodeId|role]: 'badjson' | 'schema' | 'throw' }
   * @param {number} opts.latency 每次调用的模拟延迟 ms
   */
  constructor(opts = {}) {
    this.name = 'mock';
    this.faults = opts.faults || {};
    this.latency = opts.latency ?? 0;
    this.calls = 0;
    this.roleCalls = Object.create(null);
    this.log = [];
  }

  async complete({ system, user, role, node, json, schema, temperature }) {
    this.calls++;
    this.roleCalls[role] = (this.roleCalls[role] || 0) + 1;
    const n = this.roleCalls[role];
    const seed = hash(`${role}|${node}|${n}`);
    if (this.latency) await new Promise((r) => setTimeout(r, this.latency));
    this.log.push({
      node, role, round: n,
      promptChars: (system || '').length + (user || '').length,
    });

    const fault = this.faults[node] || this.faults[role];
    if (fault === 'throw') throw new Error(`[故障注入] ${node} 模拟网络错误`);
    if (fault === 'badjson' && n === 1) return '当然可以！这是结果：\n```json\n{ tasks: [ {id:"t1", title:"未闭合';
    if (fault === 'schema' && n === 1) return JSON.stringify({ data: { wrong: true }, signals: [], issues: [] });

    // 纯文本模式：不强制 JSON，直接落盘为 data.text
    if (!json) {
      return `（mock）已按角色 ${role} 在节点 ${node} 生成文本响应。`;
    }

    // JSON 模式：根据 schema 确定性合成符合契约的 data
    const data = synthFromSchema(schema, seed);
    const conf = +(0.6 + ((seed % 30) / 100)).toFixed(2);
    const body = {
      meta: { role, v: 1, confidence: conf, mock: true, round: n },
      data,
      signals: [`${role}.done`, 'mock.done'],
      issues: [],
      next: { suggest: [], reason: '' },
    };
    return JSON.stringify(body, null, 2);
  }
}

module.exports = { MockAdapter };
