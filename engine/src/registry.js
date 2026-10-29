'use strict';
/**
 * registry.js —— 链注册表
 *
 * 链是数据不是代码，所以它们可以被扫描、被索引、被模型读写。
 * 注册表提供：加载目录 / 按 id 取链 / 保存新链 / 生成能力索引。
 *
 * 「能力索引」很重要：当元系统要生成新链时，它需要先知道
 * 已经存在哪些链、各自的 intent 是什么，才能决定是复用还是新建。
 */

const fs = require('fs');
const path = require('path');

/**
 * 名称比较器（确定性）—— V2
 *
 * 【更新来源】MCP Specification 2026-07-28 changelog 原文：
 *   "Servers SHOULD return tools from tools/list in a deterministic order
 *    to enable client-side caching and improve LLM prompt cache hit rates."
 *   规范 changelog：https://modelcontextprotocol.io/specification/2026-07-28/changelog
 * 【落地依据】docs/ajtc-vs-mcp-a2a-leftjoin.md §3「可直接抄的三点」
 *
 * 为什么换掉 localeCompare：localeCompare 的结果依赖运行环境的 locale 与 ICU 版本，
 * 同一份目录在不同机器上可能枚举出不同顺序——顺序一抖，喂给模型的清单就变，
 * LLM 的 prompt cache 全部失效。改用**码点比较**，结果与 locale 无关，跨机器恒定。
 */
function compareNameV2(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

class Registry {
  constructor(dir) {
    this.dir = dir || path.resolve(__dirname, '..', 'chains');
    this.chains = new Map();
    this.errors = [];
  }

  load() {
    this.chains.clear();
    this.errors = [];
    if (!fs.existsSync(this.dir)) { fs.mkdirSync(this.dir, { recursive: true }); return this; }
    // 递归扫描 chains/ 所有子目录（支持 chains/<域>/ 物理结构），排除 _fixture_ 夹具与 node_modules
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries.sort((a, b) => compareNameV2(a.name, b.name))) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name.startsWith('_fixture')) continue;
          walk(full);
        } else if (e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('_fixture')) {
          try {
            const c = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (!c.id) { this.errors.push({ file: full, error: '缺少 id' }); continue; }
            if (this.chains.has(c.id)) { this.errors.push({ file: full, error: `id 与 ${this.chains.get(c.id)._file} 冲突` }); continue; }
            c._file = full;
            this.chains.set(c.id, c);
          } catch (err) {
            this.errors.push({ file: full, error: err.message });
          }
        }
      }
    };
    walk(this.dir);
    return this;
  }

  has(id) { return this.chains.has(id); }
  ids() { return [...this.chains.keys()]; }

  /** 支持按 id 取，也支持直接传文件路径 */
  get(ref) {
    if (this.chains.has(ref)) return this.chains.get(ref);
    if (typeof ref === 'string' && ref.endsWith('.json')) {
      const p = path.isAbsolute(ref) ? ref : path.resolve(process.cwd(), ref);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    throw new Error(`找不到链 "${ref}"。已注册：${this.ids().join(', ') || '（空）'}`);
  }

  register(chain) { chain._file = chain._file || `${chain.id}.json`; this.chains.set(chain.id, chain); return chain; }

  save(chain, fileName) {
    const name = fileName || `${chain.id}.json`;
    const full = path.join(this.dir, name);
    const clone = { ...chain };
    delete clone._file;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify(clone, null, 2) + '\n', 'utf8');
    chain._file = name;
    this.chains.set(chain.id, chain);
    return full;
  }

  /** 能力索引：喂给 chain-architect，让它判断复用还是新建 */
  index() {
    // V2：显式按 id 排序，不再依赖 Map 插入顺序（来源同上：确定性顺序提升 prompt cache 命中率）
    return [...this.chains.values()]
      .sort((a, b) => compareNameV2(a.id || '', b.id || ''))
      .map((c) => ({
      id: c.id,
      title: c.title,
      intent: c.intent || '',
      nodes: (c.nodes || []).length,
      roles: [...new Set((c.nodes || []).map((n) => n.role).filter(Boolean))],
      entrySignals: [...new Set((c.nodes || []).flatMap((n) => (n.trigger || []).map((t) => t.on)))].filter((s) => s === 'chain.start'),
    }));
  }

  loader() { return (ref) => this.get(ref); }
}

module.exports = { Registry };
