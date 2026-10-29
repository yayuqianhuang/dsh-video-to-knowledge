// smoke.mjs — dsh-video-to-knowledge CI 冒烟测试
//
// 目标（不联网、不需要 B 站 cookie）：
//   1. 插件入口可加载、name 正确
//   2. apply(ctx) 注册了全部 6 个工具
//   3. 分发所需文件齐全（pipeline / runner / engine / 链）
//   4. 链已参数化：exec.runner === ${python}、cwd === ${workDir}
//   5. ajtc_list_chains 能列出 video-to-knowledge 的 4 条链
//   6. vk_doctor 能在临时目录里跑通并返回结构（缺依赖时也只报缺失，不抛异常）

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 配置隔离：必须在 import index.js 之前设置（CONFIG_DIR 在模块加载时求值）
process.env.VK_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vk-cfg-'));

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  [OK] ${name}`);
  else { console.error(`  [NG] ${name} ${extra}`); failures++; }
}

console.log('dsh-video-to-knowledge smoke\n');

/* 1. 入口可加载 */
let mod;
try {
  mod = await import(pathToFileURL(join(ROOT, 'index.js')).href);
  check('index.js loads', true);
  check('plugin name', mod.name === 'dsh-video-to-knowledge', `(got ${mod.name})`);
  check('apply() exported', typeof mod.apply === 'function');
  // Cordis 服务注入：不声明 inject 就访问 ctx.tools 会抛
  // "cannot get property 'tools' without inject"，插件直接激活失败。
  check('declares inject including tools',
    Array.isArray(mod.inject) && mod.inject.includes('tools'),
    `(got ${JSON.stringify(mod.inject)})`);
} catch (e) {
  check('index.js loads', false, String(e && e.message));
  console.log('\nSMOKE FAIL'); process.exit(1);
}

/* 2. 工具注册 */
const tools = new Map();
const ctx = {
  tools: { register: (t) => { if (!t || !t.name) throw new Error('tool 缺 name'); tools.set(t.name, t); } },
  systemPrompt: { section: (fn) => { ctx._prompt = fn; } },
};
mod.apply(ctx);

const EXPECT = ['vk_doctor', 'vk_login', 'vk_config', 'vk_prepare', 'vk_run', 'ajtc_run_chain', 'ajtc_list_chains', 'ajtc_recall_memory'];
for (const n of EXPECT) check(`tool ${n} registered`, tools.has(n), `(got ${[...tools.keys()].join(',')})`);
// 宿主读的是 definition.parameters（不是 MCP 的 inputSchema），缺了会在投影时抛
check('tools have parameters schema',
  [...tools.values()].every((t) => t.parameters && t.parameters.type === 'object'));
check('no leftover inputSchema field', [...tools.values()].every((t) => t.inputSchema === undefined));
// 宿主校验：output.render 必须是函数，output.schema 须落在受支持子集内
check('every tool declares output {schema, render}',
  [...tools.values()].every((t) => t.output && t.output.schema && typeof t.output.render === 'function'));
check('system prompt section injected', typeof ctx._prompt === 'function');

/* 2b. 不发布客户端 → 不应声明 dsh.client（否则是空声明） */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('no false dsh.client declaration', !(pkg.dsh && pkg.dsh.client), JSON.stringify(pkg.dsh));

/* 2c. vk_config 读写 */
const c1 = await tools.get('vk_config').execute({});
check('vk_config get', c1.content[0].text.includes('当前生效配置'));
check('vk_config shows outputDir', c1.content[0].text.includes('outputDir'));
check('vk_config shows workspace detection', c1.content[0].text.includes('是否 DSH 工作区'));
const c2 = await tools.get('vk_config').execute({ action: 'set', key: 'cookiesPath', value: '/tmp/x.txt' });
check('vk_config set', c2.content[0].text.includes('已写入'));
const c3 = await tools.get('vk_config').execute({});
check('vk_config reflects set', c3.content[0].text.includes('/tmp/x.txt'));
const c4 = await tools.get('vk_config').execute({ action: 'set', key: 'nope', value: '1' });
check('vk_config rejects unknown key', c4.content[0].text.includes('未知配置键'));
const c5 = await tools.get('vk_config').execute({ action: 'unset', key: 'cookiesPath' });
check('vk_config unset', c5.content[0].text.includes('已移除'));

/* 3. 分发文件齐全 */
for (const f of [
  'pipeline/vk_chain.py',
  'pipeline/vk_pipeline.py',
  'pipeline/clean_transcript.py',
  'runner/exec-chain.mjs',
  'engine/src/cli.js',
  'engine/chains/video-to-knowledge/gen.video-to-knowledge.json',
]) check(`file ${f}`, existsSync(join(ROOT, f)));

/* 4. 链已参数化（分发关键：不能残留绝对路径） */
const chainPath = join(ROOT, 'engine', 'chains', 'video-to-knowledge', 'gen.video-to-knowledge.json');
const chain = JSON.parse(readFileSync(chainPath, 'utf8'));
check('chain id', chain.id === 'gen.video-to-knowledge', `(got ${chain.id})`);
const execNodes = chain.nodes.filter((n) => n.exec);
check('exec specs present', execNodes.length > 0, `(got ${execNodes.length})`);
check('all exec.runner use placeholder', execNodes.every((n) => n.exec.runner === '${python}'),
  JSON.stringify(execNodes.map((n) => n.exec.runner)));
check('all exec.cwd use placeholder', execNodes.every((n) => n.exec.cwd === '${workDir}'));

// 全链扫描：不允许出现盘符绝对路径（分发到别人机器会崩）
const allChains = ['gen.video-to-knowledge.json', 'gen.video-to-knowledge.prepare.json',
  'gen.video-to-knowledge.chunk.json', 'gen.video-to-knowledge.upload.json'];
let leaked = [];
for (const f of allChains) {
  const raw = readFileSync(join(ROOT, 'engine', 'chains', 'video-to-knowledge', f), 'utf8');
  const m = raw.match(/"runner":\s*"[A-Za-z]:/g) || raw.match(/"cwd":\s*"[A-Za-z]:/g);
  if (m) leaked.push(`${f}:${m.length}`);
}
check('no absolute drive paths in exec', leaked.length === 0, leaked.join(','));

/* 5. 列链 */
const lc = await tools.get('ajtc_list_chains').execute({});
const lcText = lc.content[0].text;
check('list includes video-to-knowledge chain', lcText.includes('gen.video-to-knowledge'));

/* 6. doctor（不联网；缺依赖也只报缺失） */
const wd = mkdtempSync(join(tmpdir(), 'vk-smoke-'));
const doc = await tools.get('vk_doctor').execute({ workDir: wd });
const docText = doc.content[0].text;
check('vk_doctor returns text', typeof docText === 'string' && docText.length > 0);
check('vk_doctor mentions Python', docText.includes('Python'));
check('vk_doctor reports missing list', /缺失项/.test(docText));

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
