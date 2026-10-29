'use strict';
/**
 * validator.js —— 轻量 JSON Schema 子集校验器（零依赖）
 *
 * 支持：type / required / properties / additionalProperties / items / minItems /
 *      maxItems / enum / const / minimum / maximum / minLength / maxLength /
 *      pattern / anyOf / oneOf / allOf / nullable / uniqueItems
 *
 * 返回：{ ok: boolean, errors: [{ path, msg }] }
 * 设计取向：**报错要能直接喂回给模型做自修复**，所以 msg 用自然语言描述期望。
 */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // string / number / boolean / object / undefined
}

function typeMatch(v, t) {
  if (t === 'any') return true;
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

function validate(data, schema, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return { ok: true, errors };

  if (schema.nullable && data === null) return { ok: errors.length === 0, errors };

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatch(data, t))) {
      errors.push({ path, msg: `类型应为 ${types.join('|')}，实际为 ${typeOf(data)}` });
      return { ok: false, errors };
    }
  }

  if (schema.const !== undefined && data !== schema.const) {
    errors.push({ path, msg: `值必须等于 ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum && !schema.enum.some((e) => e === data)) {
    errors.push({ path, msg: `值必须是 ${JSON.stringify(schema.enum)} 之一，实际为 ${JSON.stringify(data)}` });
  }

  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) errors.push({ path, msg: `字符串长度至少 ${schema.minLength}` });
    if (schema.maxLength != null && data.length > schema.maxLength) errors.push({ path, msg: `字符串长度至多 ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push({ path, msg: `需匹配正则 ${schema.pattern}` });
  }

  if (typeof data === 'number') {
    if (schema.minimum != null && data < schema.minimum) errors.push({ path, msg: `数值不得小于 ${schema.minimum}` });
    if (schema.maximum != null && data > schema.maximum) errors.push({ path, msg: `数值不得大于 ${schema.maximum}` });
  }

  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) errors.push({ path, msg: `数组至少需要 ${schema.minItems} 项，实际 ${data.length} 项` });
    if (schema.maxItems != null && data.length > schema.maxItems) errors.push({ path, msg: `数组至多 ${schema.maxItems} 项` });
    if (schema.uniqueItems) {
      const seen = new Set(data.map((d) => JSON.stringify(d)));
      if (seen.size !== data.length) errors.push({ path, msg: '数组元素必须唯一' });
    }
    if (schema.items) data.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors));
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of schema.required || []) {
      if (data[key] === undefined) errors.push({ path: `${path}.${key}`, msg: `缺少必填字段 "${key}"` });
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (data[k] !== undefined) validate(data[k], sub, `${path}.${k}`, errors);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of Object.keys(data)) {
        if (!allowed.has(k)) errors.push({ path: `${path}.${k}`, msg: `不允许的额外字段 "${k}"` });
      }
    }
  }

  if (schema.allOf) schema.allOf.forEach((s) => validate(data, s, path, errors));

  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(data, s, path, []).ok);
    if (!ok) errors.push({ path, msg: '不满足 anyOf 中的任一分支' });
  }

  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => validate(data, s, path, []).ok).length;
    if (hits !== 1) errors.push({ path, msg: `oneOf 需恰好命中 1 个分支，实际命中 ${hits} 个` });
  }

  return { ok: errors.length === 0, errors };
}

/** 把错误列表压成一段可直接喂回模型的中文提示 */
function explain(errors) {
  if (!errors || !errors.length) return '';
  return errors.map((e, i) => `${i + 1}. ${e.path} → ${e.msg}`).join('\n');
}

module.exports = { validate, explain, typeOf };
