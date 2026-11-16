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
| **yt-dlp** | 抓元数据与字幕 | 见下「缺依赖怎么办」 |
| ffmpeg + faster-whisper | **仅**"无字幕视频走本地 ASR"时需要 | 不装也能用平台字幕 |
| **B 站登录 cookie** | 抓 `need_login_subtitle` 视频的字幕 | 见下 |

#### 缺依赖怎么办：探测 → 引导（不会替你装）

插件**不会**自动安装任何东西——安装期跑脚本会被 pnpm 拦（git 包默认禁止 `prepare`），运行期静默装二进制又要写用户目录、跨平台命令还各不相同。所以只做两件事：

**① 探测做厚。** `yt-dlp` 按这个顺序找，任何一档命中就能用：

```text
--ytdlp / $VK_YTDLP  →  PATH 上的 yt-dlp  →  常见安装路径  →  python -m yt_dlp
```

最后一档是为了救这个常见情况：**`pip install yt-dlp` 装过了，但 Scripts 目录不在 PATH**。只要模块装好，`python -m yt_dlp` 一定能跑，插件会自动切到「模块模式」（`vk_doctor` 里显示 `ytdlpMode: module`）。

**② 引导给准。** `vk_doctor` 会输出一个 `installPlan`，按你的系统给可复制的命令：

| 系统 | yt-dlp | ffmpeg |
|---|---|---|
| Windows | `winget install --id yt-dlp.yt-dlp -e` / `pip install -U yt-dlp` / `pipx install yt-dlp` | `winget install --id Gyan.FFmpeg -e` |
| macOS | `brew install yt-dlp` / `pipx install yt-dlp` | `brew install ffmpeg` |
| Linux | `pipx install yt-dlp` / `pip install --user -U yt-dlp` | `sudo apt install -y ffmpeg` |

装完**不用重装插件**；如果仍不在 PATH，用 `VK_YTDLP` 指路径，或直接用模块模式。

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
| **知识卡 + 一本参考书** | 「把这个视频（标题）沉淀成知识卡，并整合知识卡形成一本包含视频中所讲解所有概念的参考书（简介+目录+正文+附录）：`<链接>`」 |
| **卡片 + 大纲骨干完整版** | 「沉淀成知识卡，**另外再给一份《大纲与骨干》完整版**：`<链接>`」 |
| **只要大纲/骨干，不落库** | 「分析这个视频的大纲和骨干，先不落库：`<链接>`」 |
| **批量处理** | 「依次把这三个链接沉淀进 kb：`<链接1>` `<链接2>` `<链接3>`」 |
| **登录态排障** | 「B 站字幕抓不到，帮我配登录态」 → 触发 `vk_login` |
| **环境自检** | 「先自检环境，缺什么告诉我」 → 触发 `vk_doctor` |
| **质检返工** | 「检查 kb 里这批卡片的质量，不合格的按素材重写」 |

会触发什么（内部顺序）：

```text
"沉淀成知识卡"  → vk_doctor → vk_prepare →（模型写 cards/）→ vk_run → kb/<collection>/
"整合成一本参考书" → 同上，另加 templateParse 识别四段结构 → bookPlan 给编/章骨架
                    →（模型按编写 book/parts/*.md）→ 两遍排版 → DOCX + PDF
"分析…不落库"   → vk_prepare → 直接输出到 <outputDir>/reports/
"配登录态"      → vk_login（自动发现或给步骤）
"自检环境"      → vk_doctor
"质检/重写"     → vk_run 的 quality/dedupe 段 + 模型重写 cards/
```

### 「参考书」模板说了什么

模板里的四段是硬约束，`template` 命令会把它解析成 `deliverable=book` 与 `sections[]`：

| 段 | 内容 | 谁来写 |
|---|---|---|
| 简介 | 这本书是什么、覆盖范围、编写原则、怎么用、体例与局限 | 模型 |
| 目录 | 编—章—节三级，PDF 版带真实页码 | 排版脚本（两遍排版量页码） |
| 正文 | 按"编=一集/一章"重排，概念去重、一次讲透，其余回指 | 模型 |
| 附录 | 概念词典 / 大事年表 / 会议或条约表 / 人物索引 / 题型模板 / 覆盖核验 | 脚本汇总 + 模型补写 |

`bookplan` 只做确定性估算（每集一编、每编 2–4 章、章数按核心要点数推），**正文一个字都不代写**。

### 为什么建议加「完整版」

两份产物视角不同，**长课必须一起看**：

| 产物 | 视角 | 回答的问题 |
|---|---|---|
| `kb/` 里的卡片 | **纵向**：一个分 P 一张 | 这一节具体说了什么 |
| `reports/` 里的《大纲与骨干》 | **横向**：按主题重组 | 这门课讲什么、我该看哪几节、能省多少时间 |

复制这一句就能拿到完整版：

```text
把这个视频沉淀成知识卡，另外再给一份《大纲与骨干》完整版：
以骨干为骨架——把 5 个骨干（核心命题）作为章节，
每一块骨干下面直接展开这一段里每个分 P 的细节（一句话结论 + 3-5 条要点 + 关键时间戳）；
再补 ASR 术语校正表、按目标分流的学习路线、质量问题与跳读建议。
```

**三个说法上的小技巧**

- 说**"落库/沉淀进 kb"** → 走完整链；说**"只分析/只看大纲"** → 只出报告，不写 `kb/`
- 说**"详细点 / 完整点"** → 会出逐节详解版（每个分 P 单独一节），而不是只给五段式摘要
- 给 `outputDir` 或不给都行：不给就落 `<工作区>/videoToKnowledge/`

**视频"没字幕"时的正确排查顺序**（别急着下结论）：

1. 先看 `vk_doctor` 的 `字幕轨` 与 `B站登录态` 两行 —— 它会给结论
2. 若 `B站登录态` 是 `expired`：**先重新导出 cookie**。B 站对未登录用户不下发字幕列表，这一步最容易误判成"没有字幕"
3. 若登录正常、`字幕轨` 仍 `不可用`：播放器里能看到的中文字幕就是**硬字幕（烧在画面里）**，只能本地 ASR / OCR，或换有 `ai-zh` 字幕轨的视频

**第四种情况：有字幕，但字幕是错的。** 实测遇到过整批串台——接口给 P2/P4 返回的是另一支视频，时长往往也对得上，所以旧的"覆盖率 ≥60%"判据会全绿放行。现在由 `audit` 节点做内容级校验：**判据从视频标题/分P标题自动生成**（标题锚点覆盖率 + 跨分P相似度），不再写死成某一学科的关键词；换高数、换编程课同样能判。判不了时返回 `unverified` 并显式警告，不会静默判 ok。

## 信号节点（字幕三类坑的机器判据）

链里新增五个信号节点，每个都把一次实战教训固化成可复现的判据：

| 节点 | 触发 | 干什么 | 信号 |
|---|---|---|---|
| `probeSubs` | `meta.ready` | 多轮采样 `x/player/v2`，只保留 max(end) 落在本 P 时长 85%~115% 的轨道 | `subs.probed` / `subs.thin` |
| `auditTranscript` | `transcript.ready` | 标题锚点覆盖率 + 跨分P相似度：`mismatch` / `review` / `unverified`，不再依赖学科词表 | `audit.done` / `audit.failed` |
| `transcriptGate` | `audit.done` | 覆盖率 + 内容 verdict 双判据；`review/unverified` 继续但报告里警告 | `transcript.ok` / `transcript.mismatch` |
| `asrFallback` | `transcript.mismatch` | 只重转可疑分 P，`--merge` 重建 transcript（ASR 轨优先），再 `--audit` 复核 | `asr.done` / `asr.failed` |
| `prepareBail` | `asr.failed` 等 | ASR 也失败才早停（0 副作用） | `chain.end` |
| `templateParse` | `intake.ready` | 识别「知识卡 + 参考书（简介/目录/正文/附录）」模板 | `template.parsed` / `template.none` |
| `bookPlan` | `prepare.ok` | 给出编/章骨架与四段结构（不写正文） | `bookplan.ready` |

对应命令（都在 `pipeline/vk_chain.py`，可单独跑、只输出一个 JSON）：

```bash
python pipeline/vk_chain.py probe  --video-id BV1xx... --rounds 8     # verdict=ok / NO_USABLE_SUBS
python pipeline/vk_chain.py audit  --video-id BV1xx...                # verdict=ok/review/mismatch/unverified
python pipeline/vk_chain.py audit  --video-id BV1xx... --expect "1=函数,极限;2=导数,微分"  # 手工关键词兜底
python pipeline/vk_chain.py asr    --video-id BV1xx... --download --merge --audit  # 修完重建并复核
python pipeline/vk_chain.py template --prompt "把这个视频…参考书（简介+目录+正文+附录）：<链接>"
python pipeline/vk_chain.py bookplan --video-id BV1xx...              # 编/章骨架
```

三条踩出来的硬规则：

- **只比时长拦不住串台**。错轨可能长度恰好一样，必须做内容校验；判据要由视频主题生成，不能写死成作者自己的学科。
- **B 站字幕接口不稳定**。同一分 P 多轮结果不同，实测 2–8 轮才能拿全；单次探测的"没有字幕"结论不可信。
- **ASR 解码别用 PyAV**。faster-whisper 内部 `av.open(metadata_errors=…)` 在部分版本组合下直接 `TypeError`，改用 ffmpeg 解成 numpy 最稳；ffmpeg 只在走 ASR 时才必需，插件会自动扫 PATH / WinGet / imageio-ffmpeg，也可用 `VK_FFMPEG` 指定。

## 成书子链（可选：把卡片汇编成一本书）

提示词里出现「参考书（简介+目录+正文+附录）」时，主链会在 `bookPlan` 之后走 `bookBuild`，调用子链 `gen.video-to-knowledge.book`：

```text
assembleBook  book/front.md + parts/partNN.md + parts/appX.md → book/book_all.md
buildPass1    第一遍排版（目录占位，行数=真实条目数）→ book/pass1.docx + headings.json
pdfPass1      pass1.docx → pass1.pdf     ← 只为量页码，中间件，不交付
measureToc    从这份 PDF 按字号定位每个标题 → book/toc.json
buildFinal    第二遍排版，把页码填进目录 → reports/…docx   ← 交付物
```

两遍排版是关键：占位行数与真实条目一致，所以第二遍分页不变、页码可以直接沿用。实测 22 章、163 页、35 个标题，复测页码差异 0。

### 交付物：DOCX + Markdown，默认不出 PDF

| 产物 | 是否交付 | 说明 |
|---|---|---|
| `reports/…docx` | ✅ 主交付 | 排版完成、目录带真实页码，可直接打开/打印/二次编辑 |
| `reports/…md` | ✅ 主交付 | 全文纯文本，可 grep、可版本管理、可再排版 |
| `book/pass1.pdf` | ❌ 中间件 | 只在量页码时用，随时可删 |
| `reports/…pdf` | ❌ 默认不生成 | 只有明确要"固定分页对外分发"时才转 |

理由：PDF 把排版结果冻死了，内容一改就得重排两遍；而 DOCX 能改、MD 能搜，两者已经覆盖"读"和"改"两个场景。

真需要 PDF 时手动转一次即可：

```bash
python pipeline/book_pdf.py --in reports/xxx.docx --out reports/xxx.pdf
```

### 依赖与降级

| 依赖 | 缺失时 |
|---|---|
| python-docx | 报 `BOOK_DEPS_MISSING` + 安装提示（退出码 9），不吐栈 |
| PDF 转换器（LibreOffice Kit / soffice） | 量不了页码 → 目录退化为无页码，DOCX 照常交付 |

转换器用环境变量指定，不写进仓库：

```bash
export VK_PDF_NODE=<node 可执行文件>
export VK_PDF_CLI=<libreoffice-kit cli.js>
# 或 VK_SOFFICE=<soffice.exe>
```

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
