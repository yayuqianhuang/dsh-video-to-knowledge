#!/usr/bin/env node
/**
 * bundle-memory.mjs —— 可选：把 AJTC 的完整每日记忆日志注入插件包的 memory/raw/。
 *
 * 用法（从本仓库根目录）：
 *   node scripts/bundle-memory.mjs [--src <ajtc根/.workbuddy/memory>] [--dst memory/raw]
 *
 * 说明：
 *   - 默认不打包每日日志（见 memory/README.md 的体积/隐私理由）。
 *   - 本脚本为「可选增强」：仅复制 *.md 每日日志到 memory/raw/，绝不覆盖 iron-laws/MEMORY 等策展文件。
 *   - 复制后请人工脱敏（asset-registry 中的 IP/域名/ICP 等）再发布。
 */
import { mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SRC = resolve(HERE, '..', '..', '..', '.workbuddy', 'memory')
const DEFAULT_DST = resolve(HERE, '..', 'memory', 'raw')

const { values } = parseArgs({
  options: {
    src: { type: 'string', default: DEFAULT_SRC },
    dst: { type: 'string', default: DEFAULT_DST },
  },
})
const SRC = resolve(values.src)
const DST = resolve(values.dst)

if (!existsSync(SRC)) {
  console.error(`[bundle-memory] 源目录不存在：${SRC}`)
  process.exit(1)
}
mkdirSync(DST, { recursive: true })

let count = 0
for (const f of readdirSync(SRC)) {
  if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue // 只取每日日志
  const from = join(SRC, f)
  if (!statSync(from).isFile()) continue
  copyFileSync(from, join(DST, f))
  count++
}
console.log(`[bundle-memory] 已复制 ${count} 个每日日志 → ${DST}`)
console.log('[bundle-memory] 提醒：发布前请人工脱敏（IP/域名/ICP/工单号等）。')

function existsSync(p) {
  try { statSync(p); return true } catch { return false }
}
function dirname(p) { return p.split(/[\\/]/).slice(0, -1).join('/') }
