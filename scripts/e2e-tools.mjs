import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)

const tools = new Map()
mod.apply({ tools: { register: (t) => tools.set(t.name, t) } })

const wd = process.argv[2]
const kbPath = process.argv[3]

console.log('--- vk_doctor ---')
const doc = await tools.get('vk_doctor').execute({ url: 'https://www.bilibili.com/video/BV1RK556vESf', workDir: wd })
console.log(doc.content[0].text.split('\n').slice(0, 8).join('\n'))

console.log('\n--- vk_run ---')
const res = await tools.get('vk_run').execute({
  url: 'https://www.bilibili.com/video/BV1RK556vESf',
  kbPath,
  collection: 'bilibili',
  mode: 'upload',
  workDir: wd,
})
console.log(res.content[0].text.split('\n').slice(0, 8).join('\n'))
