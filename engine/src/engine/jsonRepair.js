'use strict';
/**
 * jsonRepair.js —— 从「模型自由文本」中稳健地抠出 JSON 并修复常见破损
 *
 * 处理顺序（每一步失败自动降级到下一步）：
 *  1. 直接 JSON.parse
 *  2. 剥离 ```json ... ``` 代码围栏 / 前后寒暄
 *  3. 括号平衡扫描，截取第一个完整的 {...} 或 [...]
 *  4. 常见畸形修复：尾逗号、单引号键值、未加引号的键、中文全角引号、
 *     NaN/Infinity/undefined、注释、换行未转义
 *  5. 括号未闭合时自动补齐
 *
 * 返回：{ ok, value, method, raw, error }
 */

function stripFence(s) {
  const m = s.match(/```(?:json|JSON|json5)?\s*([\s\S]*?)```/);
  if (m) return m[1].trim();
  return s;
}

function sliceBalanced(s) {
  const starts = [];
  for (let i = 0; i < s.length; i++) if (s[i] === '{' || s[i] === '[') { starts.push(i); break; }
  if (!starts.length) return null;
  const start = starts[0];
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start); // 未闭合，交给补齐步骤
}

function fixCommon(s) {
  let t = s;
  // 全角引号 → 半角（仅在明显的 JSON 结构位置）
  t = t.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // 去掉 // 与 /* */ 注释（跳过字符串内）
  t = t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n\r]*/g, (m, str) => str || '');
  t = t.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\//g, (m, str) => str || '');
  // 未加引号的键： {key: 1} -> {"key": 1}
  t = t.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$\-]*)\s*:/g, '$1"$2":');
  // 单引号字符串 -> 双引号（保守：内部无双引号时）
  t = t.replace(/'([^'"\\]*)'/g, '"$1"');
  // 特殊字面量
  t = t.replace(/:\s*undefined/g, ': null').replace(/:\s*NaN/g, ': null').replace(/:\s*(-)?Infinity/g, ': null');
  // 尾逗号
  t = t.replace(/,(\s*[}\]])/g, '$1');
  // 字符串中的裸换行
  t = t.replace(/"((?:\\.|[^"\\])*)"/g, (m) => m.replace(/\n/g, '\\n').replace(/\r/g, ''));
  return t.trim();
}

function closeBrackets(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
  }
  let t = s;
  if (inStr) t += '"';
  t = t.replace(/,\s*$/, '');
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  return t;
}

function tryParse(s) { try { return { ok: true, value: JSON.parse(s) }; } catch (e) { return { ok: false, error: e.message }; } }

function repair(raw) {
  if (raw && typeof raw === 'object') return { ok: true, value: raw, method: 'passthrough', raw };
  const text = String(raw ?? '');

  const steps = [
    ['direct', () => text.trim()],
    ['fence', () => stripFence(text)],
    ['balanced', () => sliceBalanced(stripFence(text)) || ''],
    ['fixed', () => fixCommon(sliceBalanced(stripFence(text)) || '')],
    ['closed', () => closeBrackets(fixCommon(sliceBalanced(stripFence(text)) || ''))],
  ];

  let lastErr = '空输入';
  for (const [method, fn] of steps) {
    let candidate;
    try { candidate = fn(); } catch (e) { lastErr = e.message; continue; }
    if (!candidate) continue;
    const r = tryParse(candidate);
    if (r.ok) return { ok: true, value: r.value, method, raw: text };
    lastErr = r.error;
  }
  return { ok: false, value: null, method: 'failed', raw: text, error: lastErr };
}

module.exports = { repair, stripFence, sliceBalanced, fixCommon, closeBrackets };
