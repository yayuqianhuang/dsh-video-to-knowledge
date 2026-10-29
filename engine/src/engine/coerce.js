'use strict';
/**
 * coerce.js —— 确定性 schema 强制 / 回填（ajtc 确定性降本 L3：受限生成 + 确定性修复）
 *
 * 与 jsonRepair（文本→JSON 提取，处理“模型吐了废话/围栏/尾逗号”）不同，本模块在
 * 「已解析出合法 JSON」之后，对值做**确定性变换**以尽量满足 node.expect 契约，从而
 * **避免为格式/类型小错重调 LLM 烧 token**：
 *   - 类型强制：string↔number/integer/boolean、标量包成数组
 *   - required 缺字段：用 properties[k].default 或 schema.default 回填（缺省填空对象/数组）
 *   - 递归：properties / items
 *   - const/enum 不匹配且有 default → 用 default
 *
 * 设计红线：**不做会“凭空捏造数据”的操作**（如 min/max 截断到边界、随机补值）。
 * 这类“只能靠模型重答”的情况，确定性修复不动，交回原 LLM 重试回路。
 *
 * 全部确定性、幂等；输入被克隆，绝不就地改原对象。
 */

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

function coerceToSchema(value, schema, path, applied) {
  path = path || '$';
  applied = applied || [];
  if (!schema || typeof schema !== 'object') return value;

  // nullable 直接透传
  if (schema.nullable && value === null) return null;

  let v = value;

  // 缺失 / null → 默认值 或 空容器
  const isMissing = v === undefined || v === null;
  if (isMissing) {
    if (schema.default !== undefined) {
      const d = clone(schema.default);
      applied.push({ path, op: 'fillDefault', msg: `用默认值 ${JSON.stringify(d)} 回填缺失字段` });
      return d;
    }
    if (schema.type === 'object') { applied.push({ path, op: 'fillObject', msg: '缺失对象以空对象回填' }); return {}; }
    if (schema.type === 'array') { applied.push({ path, op: 'fillArray', msg: '缺失数组以空数组回填' }); return []; }
    // 无 default 的标量无法确定性生成 → 原样返回，交由模型重试
    return v;
  }

  // const / enum 不匹配 → 有 default 用 default
  if (schema.const !== undefined && v !== schema.const && schema.default !== undefined) {
    const d = clone(schema.default);
    applied.push({ path, op: 'constDefault', msg: `值 ${JSON.stringify(v)} 不满足 const，用默认 ${JSON.stringify(d)}` });
    return d;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === v) && schema.default !== undefined) {
    const d = clone(schema.default);
    applied.push({ path, op: 'enumDefault', msg: `值 ${JSON.stringify(v)} 不在 enum，用默认 ${JSON.stringify(d)}` });
    return d;
  }

  // 类型强制
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
  const matches = types.some((t) => {
    if (t === 'any') return true;
    if (t === 'number') return actual === 'number' || actual === 'integer';
    if (t === 'integer') return actual === 'integer';
    return actual === t;
  });
  if (!matches && types.length) {
    if (types.includes('string') && (actual === 'number' || actual === 'boolean' || actual === 'integer')) {
      v = String(v); applied.push({ path, op: 'toString', msg: '强制转为字符串' });
    } else if ((types.includes('number') || types.includes('integer')) && actual === 'string' && String(v).trim() !== '' && !isNaN(Number(v))) {
      let n = Number(v);
      if (types.includes('integer')) n = Math.trunc(n);
      v = n; applied.push({ path, op: 'toNumber', msg: `字符串 ${JSON.stringify(v)} 强制转为数字 ${n}` });
    } else if (types.includes('boolean') && actual === 'string' && (v === 'true' || v === 'false')) {
      v = v === 'true'; applied.push({ path, op: 'toBool', msg: '字符串强制转为布尔' });
    } else if (types.includes('boolean') && (v === 1 || v === 0)) {
      v = v === 1; applied.push({ path, op: 'toBool', msg: '数字强制转为布尔' });
    } else if (types.includes('array') && actual !== 'array') {
      v = [v]; applied.push({ path, op: 'wrapArray', msg: '标量包成数组' });
    }
  }

  // 递归 properties
  if (schema.properties && v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      v[k] = coerceToSchema(v[k], sub, `${path}.${k}`, applied);
    }
    for (const k of schema.required || []) {
      if (v[k] === undefined) v[k] = coerceToSchema(undefined, schema.properties[k] || {}, `${path}.${k}`, applied);
    }
  }

  // 递归 items
  if (schema.items && Array.isArray(v)) {
    v = v.map((item, i) => coerceToSchema(item, schema.items, `${path}[${i}]`, applied));
  }

  return v;
}

/**
 * 对整封 envelope 的 data 做确定性修复。
 * @returns {{ env: object, applied: Array, changed: boolean }}
 */
function repairData(env, schema) {
  if (!env || !schema) return { env, applied: [], changed: false };
  const applied = [];
  const data = clone(env.data);
  const fixed = coerceToSchema(data, schema, '$.data', applied);
  const changed = applied.length > 0;
  const newEnv = Object.assign({}, env, { data: fixed });
  return { env: newEnv, applied, changed };
}

module.exports = { coerceToSchema, repairData, clone };
