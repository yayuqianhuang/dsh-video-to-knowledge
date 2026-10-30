# dsh-video-to-knowledge

> DeepSeek Harness（**dsh**）插件 · 把「**视频链接 → 带时间戳的 Markdown 知识卡 → 落盘 `kb/`**」这条
> AJTC 触发链封装成开箱可用的工具。

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-2EA44F)](LICENSE)

---

## 它解决什么问题

看完一个 1~5 小时的视频课，你想要的不是"看完了"，而是**可检索、可回跳、可复盘的结构化笔记**。
本插件把这件事做成一条链：抓字幕 → 清洗切块 → 组装卡片 → 五项机器校验 → 查重 → 落盘 → 计数核验 →（可选）回写大纲。

产出的每张卡片都带 `[mm:ss]` 锚点与 `source_url#t=秒` 深链，交给知识库/工作台检索后可以跳回原视频那一刻。

## 安装

```bash
dsh plugin --profile web add github:yayuqianhuang/dsh-video-to-knowledge
dsh plugin --profile web list          # 应能看到 dsh-video-to-knowledge
```

> 市场按 GitHub 仓库 topic **`dsh-plugin`** 收录；也可以用 npm 安装作为兜底（见 PUBLISH.md）。

### 你需要自备（插件无法打包）

| 依赖 | 用途 | 检查方式 |
|---|---|---|
| **Python 3.10+** | 跑流水线脚本 | 插件会依次尝试 `py -3`、`python3`、`python`；也可设 `VK_PYTHON` 指定 |
| **yt-dlp** | 抓元数据与字幕 | `pip install -U yt-dlp` |
| ffmpeg + faster-whisper | **仅**"无字幕视频走本地 ASR"时需要 | 不装也能用平台字幕 |
| **B 站登录 cookie** | 抓 `need_login_subtitle` 视频的字幕 | 见下 |

## 第一次用：三步

```
① vk_doctor   →  看缺失项
② vk_prepare  →  抓元数据 + 字幕 + 清洗切块，拿到按分 P 的素材包
③ （模型读素材写卡片正文）→ vk_run  →  校验 + 落盘 + 核验
```

### ① 自检

```jsonc
// 工具入参示例
{ "url": "https://www.bilibili.com/video/BVxxxxxxx", "cookiesPath": "D:/tmp/bili-cookies.txt" }
```

输出会告诉你 Python / yt-dlp / ffmpeg / whisper 是否可用，以及 `B站登录态` 是 `valid` / `partial` / `invalid`。

### ② 准备素材

`vk_prepare` 返回：

```jsonc
{
  "videoId": "BVxxxxxxx",
  "durationSec": 16572,
  "segmentCount": 5993,
  "coveredSec": 16571,
  "parts": 19,
  "materialDir": "<workDir>/runs/BVxxxxxxx/by_p",
  "materials": [ { "part": 1, "file": ".../p01.txt" }, ... ],
  "next": [ "...读素材写卡片正文...", "写完调用 vk_run" ]
}
```

素材文件每行形如 `[mm:ss] 内容`，时间戳是**整视频累计时间**（不是分 P 内时间）。

### ③ 写卡片正文（这一步必须由模型完成）

在 `<workDir>/cards/` 下创建 `card-<videoId>-pNN.md`，**只写正文，不要写 frontmatter**：

```markdown
# P1 · 系统介绍

## 一句话结论
……

## 核心要点
- [00:11] ……
- [00:53] ……

## 章节时间轴
| 时间 | 主题 | 一句话 |
|---|---|---|
| 00:00 | 开场 | …… |

## 关键概念
## 可执行清单
## 存疑 / 未覆盖
```

`frontmatter`（含 `content_hash`）、文件命名、索引都由链自动生成。

### ④ 落盘

```jsonc
{
  "url": "https://www.bilibili.com/video/BVxxxxxxx",
  "kbPath": "D:/kb",
  "collection": "bilibili",
  "mode": "upload",
  "outlinePath": "D:/notes/学习大纲.md"   // 可选
}
```

返回链的执行报告：卡片数、`quality.ok`、查重命中、`verify` 计数、大纲回写节数。

## 常用提示词（复制即用）

装好之后，直接在会话里说人话即可，不需要记工具名。下面六条覆盖 90% 的用法：

| 你想干什么 | 说这句话 |
|---|---|
| **全流程沉淀一张卡** | 「把这个视频沉淀成知识卡：`<链接>`」 |
| **只要大纲/骨干，不落库** | 「分析这个视频的大纲和骨干，先不落库：`<链接>`」 |
| **批量处理** | 「依次把这三个链接沉淀进 kb：`<链接1>` `<链接2>` `<链接3>`」 |
| **登录态排障** | 「B 站字幕抓不到，帮我配登录态」 → 触发 `vk_login` |
| **环境自检** | 「先自检环境，缺什么告诉我」 → 触发 `vk_doctor` |
| **质检返工** | 「检查 kb 里这批卡片的质量，不合格的按素材重写」 |

会触发什么（内部顺序）：

```text
"沉淀成知识卡"  → vk_doctor → vk_prepare →（模型写 cards/）→ vk_run → kb/<collection>/
"分析…不落库"   → vk_prepare → 直接输出到 <outputDir>/reports/
"配登录态"      → vk_login（自动发现或给步骤）
"自检环境"      → vk_doctor
"质检/重写"     → vk_run 的 quality/dedupe 段 + 模型重写 cards/
```

**三个说法上的小技巧**

- 说**"落库/沉淀进 kb"** → 走完整链；说**"只分析/只看大纲"** → 只出报告，不写 `kb/`
- 给 `outputDir` 或不给都行：不给就落 `<工作区>/videoToKnowledge/`
- 视频没有字幕轨时（硬字幕烧录），工具会报 `NO_TRANSCRIPT`——这时要么换有字幕源的视频，要么先做本地 ASR

## 五个工具

| 工具 | 作用 | 会联网 |
|---|---|---|
| `vk_doctor` | 环境自检（含 B 站登录态） | 否 |
| `vk_login` | **登录引导**：登记 cookie 路径 / 自动发现 / 给操作说明 | 否 |
| `vk_config` | 查看 / 修改配置（见下节） | 否 |
| `vk_prepare` | 元数据 + 字幕 + 清洗切块 + 素材包 | 是（有缓存则复用） |
| `vk_run` | 跑完整链：校验 → 查重 → 落盘 → 核验 → 大纲 | 仅在需要重抓字幕时 |

另保留原 AJTC 能力：`ajtc_list_chains` / `ajtc_run_chain`（**仅 mock**）/ `ajtc_recall_memory`。

## 首次使用：怎么"登录" B 站

本插件**没有图形设置页**（原因见下节），所以登录不是填表单，而是**放一个文件 + 登记路径**。

### 三步

1. **在浏览器登录 B 站**（建议用小号，cookie 等同账号密码）
2. **导出 Netscape 格式的 cookie 文件**，放到下面任一路径（放好即可被自动发现）：
   - `~/.dsh-video-to-knowledge/bili-cookies.txt`
   - `~/.workbuddy/secrets/bili-cookies.txt`
   - 当前工作目录下的 `bili-cookies.txt`
3. **调用 `vk_login`**：就绪会写进配置；没就绪会返回逐步说明

也可以直接把路径告诉它：

```jsonc
{ "cookiesPath": "D:/某处/bili-cookies.txt" }
```

### 导出方式（任选其一）

- 浏览器扩展 **Get cookies.txt LOCALLY** → 选中 `bilibili.com` → Export
- DevTools → Network → 任一 bilibili 请求 → 右键 Copy as cURL → 转 Netscape 格式

### 三个已知坑

| 现象 | 原因 |
|---|---|
| `does not look like a Netscape format cookies file` | 文件带 **BOM**（PowerShell `>` 重定向会产生 BOM） |
| 文件只有几十字节、内容是一句"复制成功" | 用了会弹提示的扩展，存下的是提示文字而不是 cookie |
| `ERROR: Failed to decrypt with DPAPI` | 用了 `--cookies-from-browser chrome`；Chrome 新版加密解不开，改用导出文件 |

### 安全边界

`vk_login` 只做**存在性判断**：文件在不在、里面有没有 `SESSDATA` 字样。
**不读取内容、不打印、不写日志、不进模型上下文**。它登记的是"路径"，不是凭据本身。
## 配置（为什么没有图形设置页）

### 结论先说

**本插件没有设置页**，配置通过 `vk_config` 工具 + 配置文件提供。原因不是偷懒，是 dsh 的机制决定的。

### 依据：设置页必须自带客户端产物

dsh 的设置页**不会**从 JSON Schema 自动生成，它由插件自己的客户端 bundle 渲染。
同一 profile 下 6 个插件的实测对比：

| 插件 | 自带 `exports["./client"]` | 有设置页 |
|---|---|---|
| `@perrylink/dsh-github` | 有 | 有 |
| `dsh-connect-workbuddy` | 有（预打包 **597 KB**） | 有 |
| `dsh-pet` | 有 | 有 |
| `dshmarket` | 有 | 有 |
| `dsh-video-understand` | 无 | 无 |
| `dsh-web-artifact-designer` | 无 | 无 |

客户端产物是 `window.__ModuleLoader__.load({ id, factory })` 的自定义打包格式（内含 React），
需要配套构建链路才能产出。本插件不发布客户端，因此**也不声明 `dsh.client`**——
否则就是个"声明了客户端却没有产物"的空声明（骨架里原本就带着这个假声明，已移除）。

> 另外：`ctx.settings.register(namespace, schema)` 这个旧 seam 在 **dsh 0.1.7-alpha.1 已被移除**，
> 现在普通可调项都走插件 `Config` 字段。所以即使写客户端，也不是老的写法。

### 只需要配两样东西

| 配置 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `outputDir` | 否 | **`<工作区>/videoToKnowledge/`** | 输出根目录。卡片落 `<它>/kb/<collection>/`，中间产物落 `<它>/runs/`，卡片正文读 `<它>/cards/` |
| `cookiesPath` | 否 | 无 | B 站 cookie 文件（Netscape 格式、无 BOM）。只有 `need_login_subtitle` 的视频才需要 |
| `pythonPath` | 否 | 自动探测 | 高级项，一般不用管 |

### 默认输出目录怎么定成"工作区"的

**不依赖进程 cwd**——插件跑在宿主进程里，它的 cwd 未必是用户的工作区。做法是反查：

1. 用 `DSH_SESSION_ID` 在 `~/.dsh/sessions/*/` 下找名为 `session-<id>` 的目录；
2. 该目录的父目录名就是工作区的**编码形式**（反斜杠→`-`，空格→`~0020`，`(`→`~0028`，`)`→`~0029`）；
3. 但路径本身也可能含 `-`（例如 `dsh-plugins`），**单靠字符串无法还原**；
   于是对每个 `-` 回溯"分隔符 / 字面字符"两种可能，用文件系统存在性剪枝，还原出真实路径。

实测：即使进程 cwd 在插件目录，`outputDir` 仍被解析成当前工作区，来源标为 `[workspace(session)]`。

**子目录规则**（三种情形，实测）：

| 情形 | 结果 |
|---|---|
| 默认，工作区不叫 `videoToKnowledge` | `<工作区>/videoToKnowledge/kb/...`（追加一层） |
| 默认，工作区本身就叫 `videoToKnowledge` | 直接用工作区（**不再套一层**，避免 `videoToKnowledge/videoToKnowledge`） |
| 你显式指定了 `outputDir` | 原样使用，**不追加**任何子目录 |

```
# 情形 1：工作区 D:\...\deepseek-harness\default-workspace
outputDir    D:\...\deepseek-harness\default-workspace\videoToKnowledge   [workspace(session)]
· 子目录规则          默认追加 videoToKnowledge/

# 情形 2：工作区 D:\...\BountyHunter\videoToKnowledge
outputDir    D:\...\BountyHunter\videoToKnowledge                         [workspace(session)]
· 子目录规则          工作区本身就叫 videoToKnowledge，不再套一层

# 情形 3：显式指定
outputDir    D:\tmp\myout                                                 [file]
· 子目录规则          按你指定的路径，不追加子目录
```

> 解码还验证过一个刁钻情况：工作区名 `deepseek-harness` 本身带连字符，
> 编码后与路径分隔符混在一起（`--D-Users-<user>-Documents-deepseek-harness-default-workspace--`），
> 靠"回溯 + 文件系统存在性剪枝"仍能正确还原成 `D:\Users\<user>\Documents\deepseek-harness\default-workspace`。

### 用 vk_config 查看 / 修改

```jsonc
{ "action": "get" }                                        // 查看（含每个值的来源）
{ "action": "set", "key": "outputDir", "value": "D:/kb" }  // 覆盖默认输出目录
{ "action": "set", "key": "cookiesPath", "value": "D:/tmp/bili-cookies.txt" }
{ "action": "unset", "key": "cookiesPath" }                // 从配置文件删除
```

**优先级：工具入参 > 环境变量 > 配置文件 > 会话工作区 > cwd**

| 配置 | 环境变量 |
|---|---|
| `outputDir` | `VK_OUTPUT_DIR` |
| `cookiesPath` | `BILI_COOKIES` |
| `pythonPath` | `VK_PYTHON` |

配置文件：`~/.dsh-video-to-knowledge/config.json`（可用 `VK_CONFIG_DIR` 覆盖）。
放用户目录而不是插件目录——避免往只读的 `node_modules` 里写。

> 一次性的东西（`collection`、`mode`、`outlinePath`、`cardsDir`）不做成配置项，走工具入参即可：
> 它们是"这次任务"的参数，不是"这台机器"的偏好。

## 目录结构

```
.
├── index.js                 # 插件入口：注册 8 个工具 + system prompt 能力段
├── cordis.patch.yml         # dsh bundle patch（插入 profile layer 栈）
├── runner/exec-chain.mjs    # 真执行器：把链节点的 exec 规格跑起来
├── pipeline/                # 确定性内核（Python，0 token）
│   ├── vk_pipeline.py       #   抓取/转换/清洗/切块/落盘/校验 的 CLI
│   ├── vk_chain.py          #   每个子命令 = 一个黑板块的 JSON 输出
│   └── clean_transcript.py  #   去口癖 / PII 脱敏 / 切块
├── engine/                  # vendored AJTC 引擎（含本项目 4 条链）
│   └── chains/video-to-knowledge/
└── scripts/smoke.mjs        # 冒烟测试（npm test）
```

## 设计说明（为什么不是普通插件）

### 1. 为什么需要 `runner/exec-chain.mjs`

AJTC 引擎自带的 `agentStep` 只是「**代理检查点**」：它把动作描述记到黑板上，**不会执行**。
官方 `ajtc_run_chain` 更是强制 `--mock`。所以引擎原样跑这条链，`$.transcript` 等永远是空的。

本插件给每个需要跑命令的节点加了机读 `exec` 规格，由 `exec-chain.mjs` 真执行、把 stdout 的 JSON 写回黑板。
实测：17 次 exec、0 失败、quality 全绿、verify 计数一致。

### 2. 为什么链里是 0 个 `kind: llm` 节点

四条链合计 26 `fn` / 8 `gate` / 1 `chain` / 2 `map`，**`kind: llm` 为 0**。
所以"配个 API key"对这条链毫无影响——决定要不要模型的是 `agentStep` 有没有 `exec`。
唯一的模型步骤是 `compileChunk`（分块编译），在 dsh 里由**你自己**（agent）完成，这反而是最自然的分工：

> 脚本干确定性的事（0 token），模型干需要理解的事，再由脚本做机械校验。

### 3. 为什么路径全用占位符

链里的 `exec.runner` / `exec.cwd` 是 `${python}` / `${workDir}` / `${pluginRoot}`，
运行时解析——否则换个用户、换个平台必崩。冒烟测试里有一条专门断言"不允许出现盘符绝对路径"。

### 4. 为什么产物写到工作区，而不是插件目录

插件装在 `node_modules` 里，那是只读的——往里写 `runs/`、卡片、索引必然失败（或污染包）。
所以所有产物都写到 `outputDir`，默认 **`<工作区>/videoToKnowledge/`**：

```
<工作区>/videoToKnowledge/
├── kb/<collection>/     ← 成品的知识卡 + 索引（插件落盘）
├── runs/<videoId>/      ← 中间产物（meta / transcript / clean / card.json / by_p）
├── cards/               ← 模型写的卡片正文（synthesize 的输入）
└── reports/             ← 模型生成的分析报告 / 笔记（不散落在工作区根目录）
```

默认落在一个专属子目录里，是为了**不和工作区里已有的 `kb/`、`runs/` 混在一起**。
工作区本身就叫 `videoToKnowledge` 时不再套一层；你显式指定 `outputDir` 时也按你的来。
这样用户装完插件、在自己的工作区里就能直接看到产出，也方便纳入自己的 git。

## 安全

- **cookie 等同账号密码**。插件只接受 `cookiesPath`，只把它通过环境变量 `BILI_COOKIES` 传给子进程；
  **不读取内容、不打印、不落盘、不进日志、不进模型上下文**。
- 自检只做 `"SESSDATA" in blob` 的存在性判断，**不验证服务端有效性**——真正验证靠抓一次字幕。
- 抓字幕恒带 `--skip-download`，不下载、不转存视频。
- 知识库**只增不删**：同名不同内容 → 写 `-v2.md`，绝不覆盖。

### 怎么拿到 cookie

浏览器装 Cookie-Editor → 在已登录的 bilibili.com 导出 **Netscape** 格式 → 存成文件（**不要带 BOM**）。

如果文件带 BOM，yt-dlp 会报：

```
WARNING: skipping cookie file entry due to invalid length 1: '\ufeff# Netscape HTTP Cookie File\n'
ERROR: '...' does not look like a Netscape format cookies file
```

PowerShell 无 BOM 写法：

```powershell
[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
```

> 不要用 `--cookies-from-browser`：Windows 上实测会 `Failed to decrypt with DPAPI`。

## 遇到问题？

**先做这三件事**（80% 的问题在这一步就解决了）：

1. **重启 dsh** —— 插件只在启动时加载，改完不重启一定不生效
2. **在会话里说「先自检环境，缺什么告诉我」** —— 会跑 `vk_doctor`，多数环境问题它能直接指出来
3. **看下面的排错表** —— 已知问题的症状都列在那里

**还是不行？提 issue 最快**：
https://github.com/yayuqianhuang/dsh-video-to-knowledge/issues

提的时候请带上这四项，否则大概率只能来回问：

| 要带什么 | 怎么拿 |
|---|---|
| 插件版本 | `dsh plugin --profile web list \| grep video-to-knowledge` |
| 完整报错原文 | 工具返回的那一整段（别截断，尤其 `ERROR` / `Traceback` 后面） |
| `vk_doctor` 输出 | 会话里说「先自检环境」 |
| 最后那次请求 | 你说了什么、给了哪个链接（保留完整 BV 号） |

> 两个高频"不是 bug"的情况，先说清楚省得白提：
> - **视频本身没有字幕轨**（"俄语中字""中字"这类把字幕烧进画面的），抓不到是正常的——链路需要文本源
> - **装了旧版本**：`dsh plugin list` 里的版本号必须与仓库最新 Release 一致，否则你跑的是老代码

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 激活失败：`cannot get property "tools" without inject` | 入口没声明 Cordis 服务注入 | 在 `index.js` 顶层加 `export const inject = ['tools']`（访问 `ctx.tools` 之前必须声明） |
| 激活失败：`tool "x" must declare output { schema, render }` | 工具没声明输出契约 | `ctx.tools.register` 里加 `output: { schema, render }`；`render(args, value)` 必须是**函数**且返回 content 数组 |
| 激活失败：`tool "x" parameters must be lossless JSON before schema projection` | 参数 schema 用了 `inputSchema` 字段名 | 宿主只读 `definition.parameters`；把 `inputSchema:` 改成 `parameters:`（`inputSchema` 是 MCP/Anthropic 约定，dsh 不认） |
| `未找到 Python` | PATH 里没有可用解释器 | 设 `VK_PYTHON` 指向绝对路径 |
| `抓字幕失败：...需要登录态` | 该视频 `need_login_subtitle` | 传 `cookiesPath` |
| **浏览器能看到 AI 字幕，插件只有弹幕** | cookie 过期（文件里有 SESSDATA，但服务端已未登录） | `vk_doctor` 看 `B站登录态`：`expired` 就重新导出 cookie，再调 `vk_login` |
| `does not look like a Netscape format` | cookie 文件带 BOM / 存成了提示语 | 重新导出，确认首行是 `# Netscape HTTP Cookie File` |
| `quality.ok=false` | 卡片时间戳越界 / 字数不足 / frontmatter 缺 | 看 `quality.issues` |
| `verify.ok=false` | 落盘有失败（看 `verify.failures`） | 检查 `kbPath` 可写 |
| `vk_run` 报 `synthesize` 失败 | `cards/` 里没有对应分 P 的正文 | 先 `vk_prepare` 再写正文 |

## 开发

```bash
npm test          # = node scripts/smoke.mjs（44 项断言，不联网）
node scripts/e2e-tools.mjs <workDir> <kbPath>   # 直接调工具做端到端验证
```

发布步骤见 [PUBLISH.md](PUBLISH.md)。

## 联系我

- **QQ**：3080203138
- **邮箱**：1513229874@qq.com

插件用着有问题，**优先走 [Issues](https://github.com/yayuqianhuang/dsh-video-to-knowledge/issues)** —— 这样别人也能搜到答案，也方便我按版本跟进。
商务合作、或者不方便公开说的事，再直接找我。

## License

MIT
