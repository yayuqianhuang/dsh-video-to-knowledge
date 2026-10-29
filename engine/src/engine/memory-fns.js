'use strict';
/**
 * memory-fns.js —— ajtc 记忆系统 · 后端可配置适配器
 *
 * 设计要点：
 *   · fn 节点只做「确定性」动作；记忆后端可配置（用户自选）：
 *       - MEMORY_BACKEND=tencentdb → 远程 TencentDB Agent-Memory MemoryCore（/v3/* HTTP API）
 *       - MEMORY_BACKEND=local（默认）→ 本地 JSON 文件存储（开箱即用，零外部依赖）
 *   · 统一降级：后端不可达 / 写入失败时返回 {ok:false, degraded:true, error}，不抛异常、不熔断链。
 *   · 四类资产映射（边界清晰、不混用）：
 *       Chat Memory  = L0/L1/L2/L3 对话与人格蒸馏（不存代码）
 *       Skill       = 从对话切片提取的可复用步骤（有版本/触发边界/校验）
 *       Wiki        = 文档/设计稿结构化页（纯文档导入）
 *       CodeGraph   = 代码实体/调用关系图（纯代码导入）
 *
 * 注册方式（functions.js 末尾）：Object.assign(builtins, require('./memory-fns'));
 */

const fs = require('fs');
const path = require('path');

const MEMORY_BACKEND = (process.env.MEMORY_BACKEND || 'local').toLowerCase();
const MEMCORE_BASE_URL = process.env.MEMCORE_BASE_URL || 'http://127.0.0.1:8420';
const MEMCORE_API_KEY = process.env.MEMCORE_API_KEY || '';
const MEMORY_LOCAL_DIR = process.env.MEMORY_LOCAL_DIR || path.join(__dirname, '..', '.runtime', 'memory');

/* ------------------------------------------------------------------ */
/* 远程后端：TencentDB Agent-Memory MemoryCore（/v3/* HTTP API）        */
/* ------------------------------------------------------------------ */
async function memCoreHttp(method, p, { body, baseUrl, apiKey, timeoutMs = 8000 } = {}) {
  const url = (baseUrl || MEMCORE_BASE_URL).replace(/\/+$/, '') + p;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-tdai-user-key'] = apiKey;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
    if (!res.ok) {
      return { ok: false, degraded: false, status: res.status, error: text || `HTTP ${res.status}`, data: json };
    }
    return { ok: true, status: res.status, data: json };
  } catch (e) {
    // 服务未起 / 网络不可达 → 优雅降级
    return { ok: false, degraded: true, error: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 本地后端：JSON 文件存储（开箱即用，零外部依赖）                       */
/* ------------------------------------------------------------------ */
function openLocal() {
  const file = path.join(MEMORY_LOCAL_DIR, 'memory-local.json');
  let data = null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    data = raw ? JSON.parse(raw) : null;
  } catch { /* 首次运行无文件 */ }
  if (!data || typeof data !== 'object') {
    data = { conversation: [], atomic: [], scenario: [], persona: [], skill: [], wiki: [], codegraph: [] };
  }
  for (const k of ['conversation', 'atomic', 'scenario', 'persona', 'skill', 'wiki', 'codegraph']) {
    if (!Array.isArray(data[k])) data[k] = [];
  }
  const save = () => {
    try {
      fs.mkdirSync(MEMORY_LOCAL_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      return false;
    }
  };
  return { data, save, file };
}

/* ------------------------------------------------------------------ */
/* 后端抽象：所有 fn 经此分发，统一降级语义                             */
/* ------------------------------------------------------------------ */
const backend = (function buildBackend() {
  if (MEMORY_BACKEND === 'tencentdb') {
    return {
      kind: 'tencentdb',
      async addConversation(content) {
        return memCoreHttp('POST', '/v3/conversation/add', { body: { content, source: 'ajtc-memory-store' } });
      },
      async addAtomic(a) {
        return memCoreHttp('POST', '/v3/atomic/add', { body: { type: a.type || 'fact', content: a.content, confidence: a.confidence || 0.8 } });
      },
      async listScenario(prefix) {
        return memCoreHttp('GET', '/v3/scenario/list' + (prefix ? `?path_prefix=${encodeURIComponent(prefix)}` : ''));
      },
      async addPersona(p) {
        return memCoreHttp('POST', '/v3/atomic/add', { body: { type: 'persona', content: JSON.stringify(p), confidence: 0.85 } });
      },
      async searchSkill(q) {
        return memCoreHttp('GET', '/v3/skill/search' + (q ? `?query=${encodeURIComponent(q)}` : ''));
      },
      async addSkill(content) {
        return memCoreHttp('POST', '/v3/skill/conversation/add', { body: { content, source: 'ajtc-memory-store' } });
      },
      async importWiki(content) {
        return memCoreHttp('POST', '/v3/wiki/import', { body: { content, source: 'ajtc-memory-store' } });
      },
      async importCodeGraph(content) {
        return memCoreHttp('POST', '/v3/codegraph/import', { body: { content, source: 'ajtc-memory-store' } });
      },
    };
  }
  // 默认 local
  return {
    kind: 'local',
    async addConversation(content) {
      const b = openLocal();
      b.data.conversation.push({ content, at: new Date().toISOString() });
      return b.save() ? { ok: true, data: { stored: true } } : { ok: false, degraded: true, error: 'local write failed' };
    },
    async addAtomic(a) {
      const b = openLocal();
      b.data.atomic.push({ type: a.type || 'fact', content: a.content, confidence: a.confidence || 0.8, at: new Date().toISOString() });
      return b.save() ? { ok: true, data: { stored: true } } : { ok: false, degraded: true, error: 'local write failed' };
    },
    async listScenario(prefix) {
      const b = openLocal();
      let list = b.data.scenario;
      if (prefix) list = list.filter((s) => (s.path || '').startsWith(prefix));
      return { ok: true, data: { scenarios: list } };
    },
    async addPersona(p) {
      const b = openLocal();
      b.data.persona.push({ content: p, at: new Date().toISOString() });
      return b.save() ? { ok: true, data: { stored: true } } : { ok: false, degraded: true, error: 'local write failed' };
    },
    async searchSkill(q) {
      const b = openLocal();
      const ql = String(q || '').toLowerCase();
      const list = b.data.skill.filter((s) => (s.content || '').toLowerCase().includes(ql));
      return { ok: true, data: { skills: list } };
    },
    async addSkill(content) {
      const b = openLocal();
      b.data.skill.push({ content, at: new Date().toISOString() });
      return b.save() ? { ok: true, data: { stored: true } } : { ok: false, degraded: true, error: 'local write failed' };
    },
    async importWiki(content) {
      const b = openLocal();
      b.data.wiki.push({ content, at: new Date().toISOString() });
      return b.save() ? { ok: true, data: { stored: true } } : { ok: false, degraded: true, error: 'local write failed' };
    },
    async importCodeGraph(content) {
      const b = openLocal();
      b.data.codegraph.push({ content, at: new Date().toISOString() });
      return b.save() ? { ok: true, data: { stored: true } } : { ok: false, degraded: true, error: 'local write failed' };
    },
  };
})();

/** 把后端返回值映射为统一的 fn 信封（degraded 语义：后端不可达或本地写入失败） */
function wrap(ok, layer, asset, sigOnOk, degradedMsg) {
  if (ok.ok) {
    return { data: Object.assign({ ok: true, backend: backend.kind, layer: layer || null, asset: asset || null }, ok.data && typeof ok.data === 'object' ? ok.data : {}), signals: sigOnOk };
  }
  return {
    data: { ok: false, backend: backend.kind, degraded: ok.degraded, error: ok.error },
    issues: [{ severity: ok.degraded ? 'low' : 'medium', where: 'memory-backend', msg: ok.error || degradedMsg }],
    signals: ['mem.degraded'],
  };
}

/**
 * memRoute —— 路由 fn（纯确定性，不读黑板外的状态）
 * 根据 $.intake.goal 把请求分类到「四类资产 × 四层」，写入 $.mem.route。
 * 分类口径（明确划分）：
 *   asset: chat | skill | wiki | codegraph
 *   layer: L0 | L1 | L2 | L3 | null（仅 chat 资产有层）
 */
const memRoute = (args, ctx) => {
  const goal = (args && (args.goal || args.text)) ||
    (ctx && ctx.bb && ctx.bb.get('$.intake.goal')) || '';
  const g = String(goal).toLowerCase();

  let asset = 'chat';
  if (/skill|技能|步骤|sop|playbook| reusable/.test(g)) asset = 'skill';
  else if (/wiki|文档|需求|设计稿|知识页|spec|doc/.test(g)) asset = 'wiki';
  else if (/codegraph|代码图|调用关系|实体关系|代码导入|repo/.test(g)) asset = 'codegraph';

  let layer = null;
  if (asset === 'chat') {
    if (/persona|人格|画像|长期偏好/.test(g)) layer = 'L3';
    else if (/scenario|场景|情境|上下文/.test(g)) layer = 'L2';
    else if (/atomic|原子|事实|知识点/.test(g)) layer = 'L1';
    else layer = 'L0'; // 默认落对话
  }

  return {
    data: { asset, layer, goal: String(goal).slice(0, 500) },
    signals: ['mem.routed'],
    issues: [],
  };
};

/** memStoreConversation —— L0 / Chat Memory */
const memStoreConversation = async (args, ctx) => {
  const conv =
    (args && (args.conversation || args.text || args.input)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!conv) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'medium', where: 'memStoreConversation', msg: '无对话内容可存' }], signals: ['mem.l0.failed'] };
  }
  const r = await backend.addConversation(typeof conv === 'string' ? conv : JSON.stringify(conv));
  return wrap(r, 'L0', 'chat', r.ok ? ['mem.l0.stored'] : ['mem.l0.degraded']);
};

/** memUpsertAtomic —— L1 / Chat Memory */
const memUpsertAtomic = async (args, ctx) => {
  const atoms =
    (args && args.atoms) ||
    (ctx && ctx.bb && ctx.bb.get('$.mem.l0Atoms')) || [];
  if (!Array.isArray(atoms) || !atoms.length) {
    return { data: { ok: false, reason: 'no-atoms' }, issues: [{ severity: 'low', where: 'memUpsertAtomic', msg: '无原子事实可写' }], signals: ['mem.l1.skipped'] };
  }
  let okCount = 0;
  for (const a of atoms.slice(0, 50)) {
    const r = await backend.addAtomic(a);
    if (r.ok) okCount++;
  }
  return {
    data: { ok: true, backend: backend.kind, layer: 'L1', total: atoms.length, written: okCount },
    signals: okCount ? ['mem.l1.stored'] : ['mem.l1.degraded'],
    issues: okCount < atoms.length ? [{ severity: 'low', where: 'memUpsertAtomic', msg: `${atoms.length - okCount} 条原子写入失败/降级` }] : [],
  };
};

/** memBuildScenario —— L2 / Chat Memory（准备阶段，确定性） */
const memBuildScenario = async (args, ctx) => {
  const r = await backend.listScenario(args && args.pathPrefix);
  if (!r.ok) return wrap(r, 'L2', 'chat', ['mem.l2.degraded']);
  const scenarios = (r.data && (r.data.scenarios || r.data.list || [])) || [];
  return {
    data: { ok: true, backend: backend.kind, layer: 'L2', scenarioCount: scenarios.length, scenarios },
    signals: ['mem.l2.prepared'],
    issues: [],
  };
};

/** memDistillPersona —— L3 / Chat Memory（写回阶段，确定性） */
const memDistillPersona = async (args, ctx) => {
  const persona =
    (args && args.persona) ||
    (ctx && ctx.bb && ctx.bb.get('$.mem.l3Persona')) || null;
  if (!persona) {
    return { data: { ok: false, reason: 'no-persona' }, issues: [{ severity: 'low', where: 'memDistillPersona', msg: '无人格画像可写回' }], signals: ['mem.l3.skipped'] };
  }
  const r = await backend.addPersona(persona);
  return wrap(r, 'L3', 'chat', r.ok ? ['mem.l3.stored'] : ['mem.l3.degraded']);
};

/** memSkillSearch —— Skill 资产（检索） */
const memSkillSearch = async (args, ctx) => {
  const q = (args && (args.query || args.q)) ||
    (ctx && ctx.bb && ctx.bb.get('$.intake.goal')) || '';
  const r = await backend.searchSkill(q);
  if (!r.ok) return wrap(r, null, 'skill', ['mem.skill.degraded']);
  const skills = (r.data && (r.data.skills || r.data.list || [])) || [];
  return { data: { ok: true, backend: backend.kind, asset: 'skill', count: skills.length, skills }, signals: ['mem.skill.searched'] };
};

/** memSkillAdd —— Skill 资产（写入） */
const memSkillAdd = async (args, ctx) => {
  const slice = (args && (args.slice || args.content)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!slice) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'low', where: 'memSkillAdd', msg: '无 skill 切片可写' }], signals: ['mem.skill.failed'] };
  }
  const r = await backend.addSkill(typeof slice === 'string' ? slice : JSON.stringify(slice));
  return wrap(r, null, 'skill', r.ok ? ['mem.skill.added'] : ['mem.skill.degraded']);
};

/** memWikiImport —— Wiki 资产（文档导入，纯文档，不触发蒸馏） */
const memWikiImport = async (args, ctx) => {
  const doc = (args && (args.doc || args.markdown || args.content)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!doc) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'low', where: 'memWikiImport', msg: '无文档内容可导入' }], signals: ['mem.wiki.failed'] };
  }
  const r = await backend.importWiki(typeof doc === 'string' ? doc : JSON.stringify(doc));
  return wrap(r, null, 'wiki', r.ok ? ['mem.wiki.imported'] : ['mem.wiki.degraded']);
};

/** memCodeGraphImport —— CodeGraph 资产（代码导入，纯代码，与 Wiki 分离） */
const memCodeGraphImport = async (args, ctx) => {
  const repo = (args && (args.repo || args.code || args.path)) ||
    (ctx && ctx.bb && ctx.bb.get('$.input')) || null;
  if (!repo) {
    return { data: { ok: false, reason: 'empty' }, issues: [{ severity: 'low', where: 'memCodeGraphImport', msg: '无代码内容可导入' }], signals: ['mem.codegraph.failed'] };
  }
  const r = await backend.importCodeGraph(typeof repo === 'string' ? repo : JSON.stringify(repo));
  return wrap(r, null, 'codegraph', r.ok ? ['mem.codegraph.imported'] : ['mem.codegraph.degraded']);
};

module.exports = {
  memRoute,
  memStoreConversation,
  memUpsertAtomic,
  memBuildScenario,
  memDistillPersona,
  memSkillSearch,
  memSkillAdd,
  memWikiImport,
  memCodeGraphImport,
  // 暴露底层客户端供测试/调试
  _memCoreHttp: memCoreHttp,
  _backend: backend,
};
