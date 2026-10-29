'use strict';
/**
 * expr.js —— 安全表达式求值器（不使用 eval / Function）
 *
 * 用于触发条件（trigger.when）、网关分支（gate.cases）、循环收敛判定等。
 *
 * 支持语法：
 *   字面量      1  1.5  'text'  "text"  true  false  null
 *   路径        $.a.b[0].c      event.name      node.runs
 *   运算        + - * / %       == != > >= < <=      && || !      ? :
 *   成员判定    'x' in $.list   $.obj has 'key'
 *   内置函数    len exists empty defined lower upper contains startsWith endsWith
 *              count sum avg max min any all num str json regex coalesce round
 *
 * 求值上下文（ctx）约定：
 *   $      -> 黑板根对象
 *   event  -> { name, from, payload }
 *   node   -> { id, runs, kind, role }
 *   run    -> { steps, llmCalls, elapsedMs }
 *   in     -> 当前节点解析后的输入绑定
 *   last   -> 上一次节点输出的 envelope
 */

const PUNCT2 = ['&&', '||', '==', '!=', '>=', '<='];
const PUNCT1 = ['(', ')', '[', ']', ',', '.', '+', '-', '*', '/', '%', '>', '<', '!', '?', ':'];

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    // 字符串
    if (c === '"' || c === "'") {
      let j = i + 1, buf = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') { buf += src[j + 1]; j += 2; }
        else { buf += src[j]; j++; }
      }
      if (j >= src.length) throw new Error(`表达式存在未闭合字符串: ${src}`);
      out.push({ t: 'str', v: buf });
      i = j + 1; continue;
    }

    // 数字
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j; continue;
    }

    // 标识符 / 路径根（允许 $ 与 @ 开头）
    if (/[A-Za-z_$@]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$@]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j; continue;
    }

    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) { out.push({ t: 'p', v: two }); i += 2; continue; }
    if (PUNCT1.includes(c)) { out.push({ t: 'p', v: c }); i++; continue; }

    throw new Error(`表达式含非法字符 "${c}"：${src}`);
  }
  out.push({ t: 'eof', v: null });
  return out;
}

function parse(src) {
  const tk = tokenize(src);
  let p = 0;
  const cur = () => tk[p];
  const isP = (v) => tk[p].t === 'p' && tk[p].v === v;
  const isId = (v) => tk[p].t === 'id' && tk[p].v === v;
  const eat = (v) => { if (!isP(v)) throw new Error(`表达式解析失败，期望 "${v}"：${src}`); p++; };

  function ternary() {
    const c = orE();
    if (isP('?')) { p++; const a = ternary(); eat(':'); const b = ternary(); return { k: 'cond', c, a, b }; }
    return c;
  }
  function orE() { let l = andE(); while (isP('||')) { p++; l = { k: 'or', l, r: andE() }; } return l; }
  function andE() { let l = notE(); while (isP('&&')) { p++; l = { k: 'and', l, r: notE() }; } return l; }
  function notE() { if (isP('!')) { p++; return { k: 'not', e: notE() }; } return cmpE(); }
  function cmpE() {
    let l = addE();
    for (;;) {
      if (cur().t === 'p' && ['==', '!=', '>=', '<=', '>', '<'].includes(cur().v)) {
        const op = tk[p++].v; l = { k: 'bin', op, l, r: addE() };
      } else if (isId('in') || isId('has')) {
        const op = tk[p++].v; l = { k: 'bin', op, l, r: addE() };
      } else return l;
    }
  }
  function addE() {
    let l = mulE();
    while (cur().t === 'p' && (cur().v === '+' || cur().v === '-')) { const op = tk[p++].v; l = { k: 'bin', op, l, r: mulE() }; }
    return l;
  }
  function mulE() {
    let l = unaryE();
    while (cur().t === 'p' && ['*', '/', '%'].includes(cur().v)) { const op = tk[p++].v; l = { k: 'bin', op, l, r: unaryE() }; }
    return l;
  }
  function unaryE() { if (isP('-')) { p++; return { k: 'neg', e: unaryE() }; } return postfix(primary()); }

  function postfix(base) {
    for (;;) {
      if (isP('.')) {
        p++;
        if (cur().t !== 'id' && cur().t !== 'num') throw new Error(`"." 后需要属性名：${src}`);
        base = { k: 'member', obj: base, prop: { k: 'lit', v: String(tk[p++].v) } };
      } else if (isP('[')) {
        p++; const idx = ternary(); eat(']');
        base = { k: 'member', obj: base, prop: idx };
      } else return base;
    }
  }

  function primary() {
    const t = cur();
    if (t.t === 'num' || t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'id') {
      if (t.v === 'true') { p++; return { k: 'lit', v: true }; }
      if (t.v === 'false') { p++; return { k: 'lit', v: false }; }
      if (t.v === 'null') { p++; return { k: 'lit', v: null }; }
      p++;
      if (isP('(')) {
        p++; const args = [];
        if (!isP(')')) { args.push(ternary()); while (isP(',')) { p++; args.push(ternary()); } }
        eat(')');
        return { k: 'call', name: t.v, args };
      }
      return { k: 'root', name: t.v };
    }
    if (isP('(')) { p++; const e = ternary(); eat(')'); return e; }
    throw new Error(`表达式解析失败于 "${String(t.v)}"：${src}`);
  }

  const ast = ternary();
  if (cur().t !== 'eof') throw new Error(`表达式尾部有多余内容：${src}`);
  return ast;
}

/* ------------------------------- 内置函数 ------------------------------- */
const FN = {
  len: (x) => (x == null ? 0 : (Array.isArray(x) || typeof x === 'string' ? x.length : Object.keys(x).length)),
  count: (x) => FN.len(x),
  exists: (x) => x !== undefined && x !== null,
  defined: (x) => x !== undefined,
  empty: (x) => FN.len(x) === 0,
  lower: (x) => String(x ?? '').toLowerCase(),
  upper: (x) => String(x ?? '').toUpperCase(),
  contains: (hay, needle) => {
    if (hay == null) return false;
    if (Array.isArray(hay)) return hay.some((v) => v === needle);
    return String(hay).includes(String(needle));
  },
  startsWith: (s, x) => String(s ?? '').startsWith(String(x)),
  endsWith: (s, x) => String(s ?? '').endsWith(String(x)),
  sum: (a) => (Array.isArray(a) ? a.reduce((s, v) => s + (Number(v) || 0), 0) : 0),
  avg: (a) => (Array.isArray(a) && a.length ? FN.sum(a) / a.length : 0),
  max: (...a) => Math.max(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(Number)),
  min: (...a) => Math.min(...(a.length === 1 && Array.isArray(a[0]) ? a[0] : a).map(Number)),
  round: (x, n = 2) => Number(Number(x).toFixed(n)),
  num: (x) => Number(x),
  str: (x) => (typeof x === 'string' ? x : JSON.stringify(x)),
  json: (x) => JSON.stringify(x),
  any: (a, key) => (Array.isArray(a) ? a.some((v) => (key ? truthy(v?.[key]) : truthy(v))) : false),
  all: (a, key) => (Array.isArray(a) ? a.every((v) => (key ? truthy(v?.[key]) : truthy(v))) : false),
  regex: (s, re, flags) => new RegExp(re, flags || '').test(String(s ?? '')),
  coalesce: (...a) => a.find((v) => v !== undefined && v !== null),
  // 统计数组中某字段等于某值的数量：countBy($.issues,'severity','high')
  countBy: (a, key, val) => (Array.isArray(a) ? a.filter((v) => v?.[key] === val).length : 0),
  // 取数组中某字段组成的新数组：pluck($.tasks,'id')
  pluck: (a, key) => (Array.isArray(a) ? a.map((v) => v?.[key]) : []),

  /* ---------- 长篇一致性守卫（v0.2.0 新增，供 arcEnd 门机器化判定） ---------- */

  /**
   * nameConsistent(passage, worldCard, extraAllow?) -> boolean
   * 抽取正文里「以说话/动作动词收尾的中文专名」，校验是否都在世界卡角色白名单内。
   * 目的：阻止模型在长篇循环中凭空新增未声明角色（设定漂移的头号来源）。
   * 宽松策略：只抓强信号（人名+言语/动作动词），代词与泛称不计入，避免误杀。
   */
  nameConsistent: (passage, worldCard, extraAllow) => {
    const text = _asText(passage);
    if (!text) return true;
    return _violations(text, 'name', _nameAllowSet(worldCard, extraAllow)).length === 0;
  },

  /**
   * noUndeclaredSetting(passage, worldCard, extraAllow?) -> boolean
   * 抽取正文里「机构/法则类后缀专名」（如 XX局 / XX议会 / XX之庭 / XX大阵），
   * 校验是否都在组织白名单 ∪ 术语白名单内。防止新增未声明的组织与体系。
   */
  noUndeclaredSetting: (passage, worldCard, extraAllow) => {
    const text = _asText(passage);
    if (!text) return true;
    return _violations(text, 'setting', _settingAllowSet(worldCard, extraAllow)).length === 0;
  },

  /**
   * driftReport(passage, worldCard, extraAllow?) -> string
   * 与上面两个判定同源，但回可读的越界清单，供 revise 提示词与军报引用。
   */
  driftReport: (passage, worldCard, extraAllow) => {
    const text = _asText(passage);
    if (!text) return '';
    const badNames = _violations(text, 'name', _nameAllowSet(worldCard, extraAllow));
    const badSets = _violations(text, 'setting', _settingAllowSet(worldCard, extraAllow));
    const parts = [];
    if (badNames.length) parts.push(`未声明角色：${badNames.join('、')}`);
    if (badSets.length) parts.push(`未声明组织/体系：${badSets.join('、')}`);
    return parts.join('；');
  },
};

/* ---------------- 一致性守卫内部工具（不暴露给表达式） ---------------- */

/** 归一化取正文：接受字符串 / {passage} / {text} / {content} / {draft} / 章节对象 */
function _asText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    for (const k of ['passage', 'text', 'content', 'draft', 'body', 'chapter']) {
      if (typeof x[k] === 'string') return x[k];
    }
    // 章节对象里正文可能嵌一层
    for (const k of ['passage', 'chapter', 'data']) {
      if (x[k] && typeof x[k] === 'object') {
        const inner = _asText(x[k]);
        if (inner) return inner;
      }
    }
  }
  return '';
}

/** 收集白名单：支持数组 / {whitelist:[]} / {a:{},b:{}} 三种形态 */
function _collectNames(src, out) {
  if (!src) return out;
  if (Array.isArray(src)) { for (const v of src) if (typeof v === 'string') out.add(v); return out; }
  if (typeof src === 'string') { out.add(src); return out; }
  if (typeof src === 'object') {
    if (Array.isArray(src.whitelist)) for (const v of src.whitelist) if (typeof v === 'string') out.add(v);
    if (src.details && typeof src.details === 'object') for (const k of Object.keys(src.details)) out.add(k);
    if (src.key && typeof src.key === 'object') {
      // "维尤十柱/灵枢氏族" 这类合写键要拆开
      for (const k of Object.keys(src.key)) for (const seg of k.split('/')) out.add(seg.trim());
    }
  }
  return out;
}

/** 中文语境里不该被当作「未声明角色」的泛称/代词 */
const _PRONOUNS = new Set([
  '他', '她', '它', '祂', '我', '你', '您', '他们', '她们', '它们', '我们', '你们',
  '有人', '没人', '众人', '所有人', '每个人', '人们', '大家', '对方', '此人', '那人', '这人',
  '男人', '女人', '老人', '孩子', '少年', '少女', '青年', '中年', '老者', '女子', '男子',
  '声音', '系统', '程序员', '守卫', '侍者', '来者', '访客', '来客', '路人',
]);

function _nameAllowSet(worldCard, extraAllow) {
  const out = new Set(_PRONOUNS);
  const wc = worldCard || {};
  _collectNames(wc.characters, out);
  // 组织也可能作为「说话方」出现（如「8567局通报说」），一并放行
  _collectNames(wc.organizations, out);
  _collectNames(extraAllow, out);
  return out;
}

function _settingAllowSet(worldCard, extraAllow) {
  const out = new Set();
  const wc = worldCard || {};
  _collectNames(wc.organizations, out);
  _collectNames(wc.systems_terminology, out);
  _collectNames(wc.characters, out);
  _collectNames(extraAllow, out);
  return out;
}

/**
 * 说话/动作动词（长词在前，避免「问」抢在「问道」之前匹配）。
 * 只有「专名 + 这些动词 + 标点/行尾」才算强信号，避免误杀普通叙述。
 */
const _SPEAK_VERBS = [
  '叹了口气', '摇了摇头', '点了点头', '沉默了', '问道', '答道', '开口', '沉默',
  '皱眉', '抬头', '低头', '转身', '站起', '坐下', '笑了', '点头', '摇头',
  '说', '道', '问', '答',
];

/** 机构 / 法则体系后缀（长词在前） */
const _SETTING_SUFFIX = [
  '世界维序者管理局', '管理局', '编织廷', '联合体', '隐修会', '议会', '协会',
  '之庭', '氏族', '大阵', '中枢', '学院', '十柱', '九境', '九界', '之海', '局',
];

/**
 * 「局」等后缀的常见非机构组合，命中即跳过。
 * 注意：这里**不能**放单字 '局'、也不能放 '学院'/'之海' 这类本身就是机构/体系后缀的词，
 * 否则「黑水局」「星辰学院」「腐朽之海」这类未声明设定会被静默放行（漏检）。
 */
const _SETTING_STOP = new Set([
  '结局', '格局', '大局', '全局', '布局', '棋局', '时局', '战局', '开局', '终局',
  '僵局', '饭局', '骗局', '残局', '定局', '变局', '当局', '出局', '入局', '局面',
  '医院', '学院派',
]);

/** 动词后必须紧跟的边界字符 */
const _BOUNDARY = /[，。、；：？！…—“”"'’‘\s\r\n)）]/;

const _CJK = /[\u4e00-\u9fa5]/;
/** 机构名可含数字/拉丁（如 8567局、GB/T8567、Z先生），故前缀字符集比人名宽 */
const _NAMECHAR = /[\u4e00-\u9fa5A-Za-z0-9]/;

/**
 * 单字后缀（如「局」）的「后接字构成常用词」黑名单：
 * 「局面/局势/局部…」是普通词而非机构，若 `局` 后紧跟这些字则跳过。
 */
const _SUFFIX_FWD_STOP = {
  局: new Set(['面', '势', '部', '限', '子', '中', '内', '外', '促']),
};

/**
 * 通用「后缀扫描器」：在 text 中定位每个后缀词，向前取最多 maxPrefix 个中文字，
 * 产出从长到短的候选串。这样 `世界维序者管理局` 能整体命中白名单，
 * 而 `这不是结局` 会命中停用词表，不再出现惰性匹配抓到 `是结局` 的老问题。
 */
function _scanBySuffix(text, suffixes, maxPrefix, requireBoundary, charRe) {
  const hits = [];
  const taken = []; // 记录已消费区间，避免「管理局」又被「局」重复计一次
  const cls = charRe || _CJK;
  for (const suf of suffixes) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(suf, from);
      if (at < 0) break;
      from = at + suf.length;
      const end = at + suf.length;
      if (taken.some(([s, e]) => at < e && end > s)) continue;
      if (requireBoundary) {
        const nextCh = text[end];
        if (nextCh !== undefined && !_BOUNDARY.test(nextCh)) continue;
      }
      // 单字后缀：后接字若构成常用词（局面/局势…）则不是机构名
      const fwdStop = _SUFFIX_FWD_STOP[suf];
      if (fwdStop && text[end] !== undefined && fwdStop.has(text[end])) continue;
      // 向前收集连续专名字符
      let start = at;
      while (start > 0 && (end - start) < (maxPrefix + suf.length) && cls.test(text[start - 1])) start--;
      const full = text.slice(start, end);
      const candidates = [];
      for (let i = 0; i <= full.length - suf.length; i++) {
        const c = full.slice(i);
        if (c.length >= 1) candidates.push(c);
      }
      hits.push({ suffix: suf, at, full, candidates });
      taken.push([at, end]);
    }
  }
  return hits;
}

/**
 * 返回违规词清单（空数组 = 通过）。
 * mode='name'    → 说话人必须在角色白名单
 * mode='setting' → 机构/体系必须在组织∪术语白名单
 */
function _violations(text, mode, allow) {
  const bad = [];
  const isName = mode === 'name';
  const hits = isName
    ? _scanBySuffix(text, _SPEAK_VERBS, 5, true, _CJK)
    : _scanBySuffix(text, _SETTING_SUFFIX, 8, false, _NAMECHAR);

  for (const h of hits) {
    // 人名模式下候选要剔掉动词本身
    const cands = isName
      ? h.candidates.map((c) => c.slice(0, c.length - h.suffix.length)).filter((c) => c.length >= 2 && c.length <= 5)
      : h.candidates;
    if (!cands.length) continue;
    // 从长到短：任一候选命中白名单即放行
    const sorted = [...cands].sort((a, b) => b.length - a.length);
    if (sorted.some((c) => allow.has(c))) continue;
    if (!isName && sorted.some((c) => _SETTING_STOP.has(c))) continue;
    if (isName && sorted.some((c) => _PRONOUNS.has(c))) continue;
    // 取「合理长度」的最长候选作为违规词上报（人名≤4字，机构=后缀+至多4字）
    const pick = isName
      ? (sorted.find((c) => c.length <= 4) || sorted[sorted.length - 1])
      : (sorted.find((c) => c.length <= h.suffix.length + 4) || sorted[sorted.length - 1]);
    if (pick && !bad.includes(pick)) bad.push(pick);
  }
  return bad;
}

function truthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v !== 'false';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

function evalNode(n, ctx) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'root': {
      if (Object.prototype.hasOwnProperty.call(ctx, n.name)) return ctx[n.name];
      return undefined;
    }
    case 'member': {
      const o = evalNode(n.obj, ctx);
      if (o === undefined || o === null) return undefined;
      const key = evalNode(n.prop, ctx);
      return o[key];
    }
    case 'call': {
      const f = FN[n.name];
      if (!f) throw new Error(`未知函数 ${n.name}()`);
      return f(...n.args.map((a) => evalNode(a, ctx)));
    }
    case 'not': return !truthy(evalNode(n.e, ctx));
    case 'neg': return -Number(evalNode(n.e, ctx));
    case 'and': return truthy(evalNode(n.l, ctx)) ? truthy(evalNode(n.r, ctx)) : false;
    case 'or': return truthy(evalNode(n.l, ctx)) ? true : truthy(evalNode(n.r, ctx));
    case 'cond': return truthy(evalNode(n.c, ctx)) ? evalNode(n.a, ctx) : evalNode(n.b, ctx);
    case 'bin': {
      const a = evalNode(n.l, ctx);
      const b = evalNode(n.r, ctx);
      switch (n.op) {
        case '+': return (typeof a === 'string' || typeof b === 'string') ? String(a) + String(b) : Number(a) + Number(b);
        case '-': return Number(a) - Number(b);
        case '*': return Number(a) * Number(b);
        case '/': return Number(b) === 0 ? 0 : Number(a) / Number(b);
        case '%': return Number(b) === 0 ? 0 : Number(a) % Number(b);
        case '==': {
          // 对齐 JS 标准语义：null == undefined 视为相等；其它走严格比较。
          if (a == null && b == null) return true;
          if (a == null || b == null) return false;
          return a === b;
        }
        case '!=': {
          // 与 == 对称：null/undefined 在一起判相等
          if (a == null && b == null) return false;
          if (a == null || b == null) return true;
          return a !== b;
        }
        case '>': return Number(a) > Number(b);
        case '>=': return Number(a) >= Number(b);
        case '<': return Number(a) < Number(b);
        case '<=': return Number(a) <= Number(b);
        case 'in': return FN.contains(b, a);
        case 'has': return a != null && typeof a === 'object' && Object.prototype.hasOwnProperty.call(a, b);
        default: throw new Error(`未知运算符 ${n.op}`);
      }
    }
    default: throw new Error(`未知 AST 节点 ${n.k}`);
  }
}

const cache = new Map();
function compile(src) {
  if (!cache.has(src)) cache.set(src, parse(src));
  return cache.get(src);
}

/** 求值，返回原始值 */
function evaluate(src, ctx) {
  if (src === undefined || src === null || src === '') return undefined;
  if (typeof src !== 'string') return src;
  return evalNode(compile(src), ctx || {});
}

/** 求值为布尔（触发条件专用），出错时按 false 处理并记录 */
function test(src, ctx, onError) {
  if (!src) return true;
  try { return truthy(evaluate(src, ctx)); }
  catch (e) { if (onError) onError(e); return false; }
}

module.exports = { evaluate, test, truthy, compile, tokenize, FN };
