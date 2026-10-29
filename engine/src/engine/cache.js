'use strict';
/**
 * cache.js —— 信号级记忆化 / 幂等缓存原语（ajtc 确定性降本 L2）
 *
 * 设计要点：
 *  - 缓存键 =「节点 id + 触发事件名 + 入参稳定哈希 [+ 渲染后 prompt 哈希]」。
 *    相同节点 + 相同信号 + 相同入参 ⇒ 命中；prompt 模板或入参一变即自动失效。
 *  - 默认每 run 新建（进程内、run 级幂等）；调用方传入同一实例即可实现跨 run 记忆化。
 *  - 确定性节点（fn/gate）默认可缓存；LLM 需显式 node.cache:true（避免掩盖非确定性）。
 *  - LRU + TTL + maxEntries 三重护栏，防内存膨胀或被陈旧项误导。
 */

// 稳定序列化：键排序 + 处理 NaN/Infinity/bigint/function/循环引用，保证同值同串
function stableStringify(v, seen) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (v !== v) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return JSON.stringify(v);
  }
  seen = seen || new Set();
  if (seen.has(v)) return '[circular]';
  seen.add(v);
  if (Array.isArray(v)) {
    const inner = v.map((x) => stableStringify(x, seen)).join(',');
    seen.delete(v);
    return '[' + inner + ']';
  }
  const keys = Object.keys(v).sort();
  const inner = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k], seen)).join(',');
  seen.delete(v);
  return '{' + inner + '}';
}

// FNV-1a 32-bit → 8 位 hex。碰撞仅影响"少命中"，不致命。
function stableHash(obj) {
  const s = stableStringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

class SignalCache {
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : 256;
    this.defaultTtlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 0; // 0 = 永不过期
    this.map = new Map(); // key -> { value, expAt }
  }

  _now() { return Date.now(); }

  has(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (e.expAt && e.expAt <= this._now()) { this.map.delete(key); return false; }
    return true;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expAt && e.expAt <= this._now()) { this.map.delete(key); return undefined; }
    // LRU：访问即移到末尾
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    const ttl = (ttlMs && ttlMs > 0) ? ttlMs : this.defaultTtlMs;
    this.map.set(key, { value, expAt: ttl ? this._now() + ttl : 0 });
    // 淘汰最旧（Map 头部 = 最早插入/访问）
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }

  /**
   * setScoped(key, value, policy) —— V2：带显式新鲜度策略的写入
   *
   * 【更新来源】MCP Specification 2026-07-28 · SEP-2549（CacheableResult：ttlMs + cacheScope）
   * 【落地依据】docs/ajtc-vs-mcp-a2a-leftjoin.md §3
   * 【兼容性】原 set() 保持原样不动（Vn 风格并存）；setScoped 在其之上**额外记录**
   *   policy 元数据。注意：scope 目前只做元数据记录与统计，**不改变命中判定**——
   *   能否跨 run 复用仍取决于调用方是否注入同一 SignalCache 实例（既有语义不变）。
   */
  setScoped(key, value, policy) {
    const p = policy || {};
    const ttlMs = Number.isFinite(p.ttlMs) && p.ttlMs > 0 ? p.ttlMs : undefined;
    this.set(key, value, ttlMs);
    const e = this.map.get(key);
    if (e) { e.scope = p.scope || 'run'; e.storedAt = this._now(); }
    return this;
  }

  /** V2：按 scope 统计条目数（可观测性用） */
  statsByScope() {
    const out = {};
    for (const e of this.map.values()) {
      const s = e.scope || 'run';
      out[s] = (out[s] || 0) + 1;
    }
    return out;
  }

  clear() { this.map.clear(); return this; }
  get size() { return this.map.size; }
}

module.exports = { SignalCache, stableHash, stableStringify };
