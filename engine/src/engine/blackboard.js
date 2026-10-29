'use strict';
/**
 * blackboard.js —— 全局共享状态「黑板」
 *
 * 所有节点通过黑板读写，路径语法：$.a.b[0].c
 * 这是整个触发链的唯一真实来源（single source of truth）。
 */

function tokens(path) {
  const p = String(path).replace(/^\$\.?/, '');
  if (!p) return [];
  return p
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((x) => x !== '');
}

class Blackboard {
  constructor(initial = {}) {
    this.data = JSON.parse(JSON.stringify(initial));
    this.writes = [];
  }

  get(path, fallback) {
    if (path === '$' || path === undefined || path === null) return this.data;
    let cur = this.data;
    for (const t of tokens(path)) {
      if (cur === undefined || cur === null) return fallback;
      cur = cur[t];
    }
    return cur === undefined ? fallback : cur;
  }

  set(path, value) {
    if (!path || path === '$') { this.data = value; this.writes.push({ path: '$', at: Date.now() }); return value; }
    const ts = tokens(path);
    let cur = this.data;
    for (let i = 0; i < ts.length - 1; i++) {
      const k = ts[i];
      const nextIsIndex = /^\d+$/.test(ts[i + 1]);
      if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') cur[k] = nextIsIndex ? [] : {};
      cur = cur[k];
    }
    cur[ts[ts.length - 1]] = value;
    this.writes.push({ path, at: Date.now() });
    return value;
  }

  push(path, value) {
    const arr = this.get(path);
    if (Array.isArray(arr)) { arr.push(value); this.writes.push({ path: `${path}[]`, at: Date.now() }); return arr; }
    return this.set(path, [value]);
  }

  merge(path, obj) {
    const cur = this.get(path);
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) return this.set(path, { ...cur, ...obj });
    return this.set(path, obj);
  }

  snapshot() { return JSON.parse(JSON.stringify(this.data)); }
}

module.exports = { Blackboard, tokens };
