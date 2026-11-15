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
  'pipeline/vk_signals.py',
  'pipeline/clean_transcript.py',
  'runner/exec-chain.mjs',
  'engine/src/cli.js',
  'engine/chains/video-to-knowledge/gen.video-to-knowledge.json',
  'engine/chains/video-to-knowledge/gen.video-to-knowledge.prepare.json',
]) check(`file ${f}`, existsSync(join(ROOT, f)));

/* 3b. 回归断言（来自真实反馈：这三处一旦被改回去，用户侧会静默坏掉） */
const idxSrc = readFileSync(join(ROOT, 'index.js'), 'utf8');
const pipeSrc = readFileSync(join(ROOT, 'pipeline', 'vk_pipeline.py'), 'utf8');
const chainSrc = readFileSync(join(ROOT, 'pipeline', 'vk_chain.py'), 'utf8');

// P2：vk_prepare 必须解构 outputDir，否则入参被静默丢弃（schema 里声明了却不用）
check('vk_prepare destructures outputDir',
  /async execute\(\{\s*url,\s*outputDir/.test(idxSrc));
// P3：中文 Windows 下子进程按 cp936 输出，父进程必须强制 UTF-8 + 有 cp936 兜底
check('run_cmd forces UTF-8 for child process', pipeSrc.includes('PYTHONUTF8'));
check('run_cmd falls back to cp936', pipeSrc.includes('cp936'));
// P4：--cookies 会被 yt-dlp 回写；只读路径会 PermissionError，必须复制到临时目录
check('cookie copied before yt-dlp', chainSrc.includes('_cookie_copy'));
// P1：报错必须能区分"下载了但解析不出序号"
check('NO_TRANSCRIPT split from unparsed', chainSrc.includes('SRT_FOUND_BUT_UNPARSED'));

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

/* 4b. 信号节点齐全（实测教训：字幕串台 / 接口不稳定 / 无字幕，三条都要有兜底） */
const prepPath = join(ROOT, 'engine', 'chains', 'video-to-knowledge',
  'gen.video-to-knowledge.prepare.json');
const prep = JSON.parse(readFileSync(prepPath, 'utf8'));
const prepIds = prep.nodes.map((n) => n.id);
for (const id of ['probeSubs', 'auditTranscript', 'asrFallback']) {
  check(`signal node ${id}`, prepIds.includes(id));
}
const auditNode = prep.nodes.find((n) => n.id === 'auditTranscript');
check('audit emits mismatch signal',
  !!auditNode && JSON.stringify(auditNode).includes('audit.done'));
const asrNode = prep.nodes.find((n) => n.id === 'asrFallback');
check('asr triggered by mismatch or fail',
  !!asrNode && ['transcript.mismatch', 'transcript.fail']
    .every((s) => JSON.stringify(asrNode.trigger).includes(s)));
const gate = prep.nodes.find((n) => n.id === 'transcriptGate');
check('gate checks content not just coverage',
  !!gate && JSON.stringify(gate).includes('$.audit.ok'));

const mainIds = chain.nodes.map((n) => n.id);
for (const id of ['templateParse', 'bookPlan', 'bookGate', 'bookBuild']) {
  check(`signal node ${id}`, mainIds.includes(id));
}
const tpl = chain.nodes.find((n) => n.id === 'templateParse');
check('template node reads prompt', !!tpl && JSON.stringify(tpl).includes('input.prompt'));

/* 4c. 成书子链（拼稿 → 两遍排版 → 量页码 → DOCX/PDF） */
const bookPath = join(ROOT, 'engine', 'chains', 'video-to-knowledge',
  'gen.video-to-knowledge.book.json');
check('file gen.video-to-knowledge.book.json', existsSync(bookPath));
const book = JSON.parse(readFileSync(bookPath, 'utf8'));
const bookIds = book.nodes.map((n) => n.id);
for (const id of ['assembleBook', 'buildPass1', 'pdfPass1', 'measureToc', 'buildFinal', 'pdfFinal']) {
  check(`book node ${id}`, bookIds.includes(id));
}
const bookExec = book.nodes.filter((n) => n.exec);
check('book exec all use ${python}', bookExec.every((n) => n.exec.runner === '${python}'));
check('book exec all use ${workDir}', bookExec.every((n) => n.exec.cwd === '${workDir}'));
check('book chain two-pass toc',
  JSON.stringify(book.nodes).includes('book/toc.json') &&
  JSON.stringify(book.nodes.find((n) => n.id === 'buildFinal')).includes('--toc'));
for (const f of ['pipeline/build_book.py', 'pipeline/measure_toc.py',
  'pipeline/assemble_book.py', 'pipeline/book_pdf.py']) {
  check(`file ${f}`, existsSync(join(ROOT, f)));
}
const assSrc = readFileSync(join(ROOT, 'pipeline', 'assemble_book.py'), 'utf8');
check('assemble_book reads utf-8-sig', assSrc.includes('utf-8-sig'));
const buildSrc = readFileSync(join(ROOT, 'pipeline', 'build_book.py'), 'utf8');
check('build_book degrades without python-docx', buildSrc.includes('BOOK_DEPS_MISSING'));
const pdfSrc = readFileSync(join(ROOT, 'pipeline', 'book_pdf.py'), 'utf8');
check('book_pdf skips when no converter', pdfSrc.includes('PDF_SKIPPED'));

// 三个新命令必须真的注册进 CLI（不然节点 exec 会 127）
const sigSrc = readFileSync(join(ROOT, 'pipeline', 'vk_signals.py'), 'utf8');
for (const cmd of ['audit', 'probe', 'asr', 'template', 'bookplan']) {
  check(`vk_signals registers ${cmd}`, sigSrc.includes(`"${cmd}"`) || sigSrc.includes(`'${cmd}'`));
}
check('chain imports vk_signals', chainSrc.includes('vk_signals'));

/* 4e. 发版工作流：推 tag 即发版，用内置 token（不落长期密钥） */
const relPath = join(ROOT, '.github', 'workflows', 'release.yml');
check('file .github/workflows/release.yml', existsSync(relPath));
const relSrc = existsSync(relPath) ? readFileSync(relPath, 'utf8') : '';
check('release workflow triggers on v* tags', /tags:\s*\n\s*-\s*'v\*'/.test(relSrc));
check('release workflow uses builtin token', relSrc.includes('github.token'));
check('release workflow is idempotent', relSrc.includes('gh release view') && relSrc.includes('gh release edit'));
check('release workflow declares contents:write', /permissions:\s*\n\s*contents:\s*write/.test(relSrc));

/* 4d. 缺依赖：探测做厚 + 引导给准（不自动安装） */
check('vk_pipeline has ytdlp_cmd', pipeSrc.includes('def ytdlp_cmd'));
check('module fallback uses yt_dlp', pipeSrc.includes('"-m", "yt_dlp"'));
check('vk_chain uses ytdlp_cmd', chainSrc.includes('vp.ytdlp_cmd('));
check('vk_chain has install plan', chainSrc.includes('_install_plan'));
check('doctor emits installPlan', chainSrc.includes('"installPlan"'));
const idxSrc2 = readFileSync(join(ROOT, 'index.js'), 'utf8');
check('vk_doctor renders installPlan', idxSrc2.includes('d.installPlan'));
check('no silent auto-install', !/pip install[^`\n]*\+\+|subprocess[^\n]*pip install/.test(chainSrc));

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
