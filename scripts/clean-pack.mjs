// clean-pack.mjs — prepack 守卫：发布前清掉运行时垃圾，避免打进 tarball
//
// 为什么需要：`files` 是白名单，但它按目录整体包含。`pipeline/` 下会被 Python 生成
// `__pycache__/*.pyc`，`engine/` 下会有 `.runtime/`、`run-shadow/` 之类运行时产物。
// 这些都不该分发给用户（体积 + 可能残留本机信息）。

import { rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const TARGETS = [
  'pipeline/__pycache__',
  'engine/src/.runtime',
  'engine/run-shadow',
  '.runtime',
]

let removed = 0
const rel = (p) => p.slice(ROOT.length + 1)

function drop(p, label) {
  if (!existsSync(p)) return
  rmSync(p, { recursive: true, force: true })
  // 写 stderr：prepack 的 stdout 会混进 `npm pack --json`，污染机器可读输出
  console.error(`[clean-pack] removed ${label || rel(p)}`)
  removed++
}

for (const t of TARGETS) drop(join(ROOT, t), t)

// 兜底：递归删掉任何 __pycache__
function sweep(dir, depth = 0) {
  if (depth > 6) return
  let names = []
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    if (name === '__pycache__') drop(p)
    else sweep(p, depth + 1)
  }
}
sweep(ROOT)

console.error(`[clean-pack] done (${removed} removed)`)
