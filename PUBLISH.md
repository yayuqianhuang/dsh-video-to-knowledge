# PUBLISH.md — 把 dsh-video-to-knowledge 发布为 dsh 插件

本文件是给**你（仓库 owner）**的发布 runbook。插件本体已完成代码卫生、跨平台化与冒烟测试，
剩下的步骤需要在**你的机器/你的账号**上执行（涉及 GitHub 鉴权、`dsh` 安装、真实联网验证）。

> ## ⚠️ 铁律：改完代码，至少升一个 patch 版本再推
>
> ```
> 0.1.0 → 0.1.1 → 0.1.2 → …
> ```
>
> **市场只看版本号。** 版本不变，用户就永远收不到你的修复——不管你推了多少提交。
>
> 实测代价：我们连推 4 个修复提交却把版本停在 `0.1.0`，市场直接提示
> 「所选分支上有比你已装版本更新的提交，但没有发布新版本号；市场只安装正式版本，
> 不会自动装这些提交」——等于白改。
>
> 所以：**每次改动 = 升 patch + 打 tag + `--follow-tags` 推送**，三步缺一不可。
> 详见下文「版本与发布」。

---

## 关键事实（先读）

- 当前 `dsh-plugins/video-to-knowledge/` 只是父仓库 `AIJsonPromptChaining` 的**未跟踪子目录**，
  不是独立 git 仓库。**发布 = 把子目录抽取成独立仓库**。
- GitHub owner 假定为 `yayuqianhuang`（已写入 `package.json` 的 `repository.url`，如需改请全文替换）。
- 安装路径：`dsh plugin --profile web add github:yayuqianhuang/dsh-video-to-knowledge`
- 市场发现：仓库打 **`dsh-plugin`** topic 即被收录；**npm publish 不是必需步骤**。
- 插件**不需要**任何构建：`index.js` 是 ESM，`engine/` 是 CJS 且通过子进程隔离，`pipeline/` 是纯 Python 脚本。

---

## 发布前自检（逐项打勾）

```bash
cd dsh-plugins/video-to-knowledge
npm test                     # 冒烟全部通过（SMOKE PASS）
npm pack --dry-run           # 看真实会打进 tarball 的文件清单
```

- [ ] **版本号已升**（至少 patch；`package.json` 的 `version`），并打了对应 tag
- [ ] **Release notes 末尾带 issue 页脚**（`---` + "遇到问题请提 issue…" + 链接），每版必带
- [ ] `npm test` 通过
- [ ] `npm pack --dry-run` 清单里无 `__pycache__` / `*.pyc` / `.runtime` / `run-shadow`
      （`prepack` 钩子已自动清理，见 `scripts/clean-pack.mjs`）
- [ ] `npm pack --dry-run --json` 能被 `JSON.parse`（prepack 日志走 stderr，不污染 stdout）
- [ ] `package.json` 的 `name` 与 `cordis.patch.yml` 的 `id/name` 一致
- [ ] `files` 数组包含 `index.js, cordis.patch.yml, engine, pipeline, runner, memory, README.md, LICENSE`
- [ ] 链里**没有**盘符绝对路径（冒烟测试已断言）
- [ ] 全仓库搜一遍机器专属路径无命中（`rg -n 'Users[\\/]|Program Files' --glob '!node_modules'`）
- [ ] 没有把任何 cookie / SESSDATA 提交进仓库

建议 `.gitignore`：

```
.runtime/
node_modules/
cookies.txt
bili-cookies.txt
```

---

## Phase 2 — 抽取为独立仓库

```bash
SRC="<你的 AIJsonPromptChaining 仓库>/dsh-plugins/video-to-knowledge"
DST="$HOME/dsh-video-to-knowledge"

rm -rf "$DST" && mkdir -p "$DST"
cp -R "$SRC/." "$DST/"
cd "$DST"
rm -rf .runtime node_modules
git init -b main
git add -A
git status          # 人工确认：无本机用户名 / 机器目录 / 任何 cookie
git commit -m "feat: dsh-video-to-knowledge v0.1.0 — video→knowledge-card chain as a dsh plugin"
```

## Phase 3 — 建仓库并推送

```bash
git remote add origin git@github.com:yayuqianhuang/dsh-video-to-knowledge.git
ssh -T git@github.com
git push -u origin main
```

## Phase 4 — 打 topic（市场发现的关键）

仓库主页 → About ⚙ → 添加：

- `dsh-plugin`（**必须**）
- `deepseek-harness`
- `video-to-knowledge`
- `bilibili`
- `yt-dlp`

## Phase 5 — 干净机器验证

```bash
dsh plugin --profile web add github:yayuqianhuang/dsh-video-to-knowledge
dsh plugin --profile web list | grep video-to-knowledge
```

装好后在对话里让它：

1. `vk_doctor` —— 应报出 Python / yt-dlp 状态
2. `vk_prepare`（给一个短的有字幕视频）—— 应返回 `materials[]`
3. 写一张卡 → `vk_run` —— 应返回 `链跑通 ✔`

> 若报 `engines.dsh` 不满足，核对本机 dsh 版本是否在 `>=0.1.0-rc.7 <0.3.0`。

## Phase 6 — 回滚

```bash
dsh plugin --profile web remove dsh-video-to-knowledge
```

---

## 可选：npm 兜底发布

仓库名与包名一致时可直接：

```bash
npm publish --access public
```

---

---

## 版本与发布（完整流程）

一句话：**改代码 → 测试 → 升版本 → 提交 → 打 tag → 推 → GitHub Release → 分发**。
前 5 步在命令行，第 6 步在网页，第 7 步是通知用户。

> 为什么必须走完：市场按**版本号**判断有没有更新。只 push 提交而不升 `version`，市场认为你已是最新，
> 连推 4 个修复提交都等于白改（这是真实踩过的坑，见开头的「铁律」）。

### 步骤 0 · 确认起点干净

```bash
cd /d/Users/24485/Desktop/BountyHunter/dsh-video-to-knowledge
git status                       # 期望：nothing to commit, working tree clean
npm test                         # 期望：SMOKE PASS（44 项）
node -e "console.log(require('./package.json').version)"   # 记下当前版本
```

### 步骤 1 · 改代码（这一步不碰版本号）

改完跑一遍 `npm test`。**测试不过就不要往下走**——发出去的版本收不回来。

### 步骤 2 · 升版本（决定 patch / minor）

| 改了什么 | 升哪一位 | 例子 |
|---|---|---|
| 修 bug、改文案、加/改测试断言 | **patch** | `0.1.4 → 0.1.5` |
| 加工具、加能力、加可选参数（向后兼容） | **minor** | `0.1.5 → 0.2.0` |
| 改参数名、删工具、改默认行为（不兼容） | **minor 或 major** | `0.2.0 → 0.3.0` |

只改**仓库**的 `package.json`（其余副本用同步脚本处理，别手改四份）。

```bash
# 用 node 改，比手编辑不容易漏引号
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('package.json','utf8'));j.version='0.1.6';fs.writeFileSync('package.json',JSON.stringify(j,null,2)+'\n')"
```

### 步骤 3 · 提交

```bash
git add -A
git commit -m "chore(release): v0.1.6"
```

如果版本号是和功能一起改的，也可以合成一个提交：

```bash
git commit -m "fix(transcript): 单 P 视频字幕被丢弃

- p_index_from_name 支持 NA_ 前缀
- 回归断言：单 P 视频 transcript 后 segmentCount > 0

版本 0.1.4 -> 0.1.5"
```

### 步骤 4 · 打 tag（annotated，不是轻量 tag）

```bash
git tag -a v0.1.6 -m "dsh-video-to-knowledge v0.1.6"
```

> 必须 `-a`（annotated）。轻量 tag 在某些工具链里拿不到日期/作者。

### 步骤 5 · 推送（必须带 `--follow-tags`）

```bash
git push origin main --follow-tags
```

**验证**（这一步别省，它决定市场能不能看见）：

```bash
git ls-remote --tags origin | grep v0.1.6
# 期望两行：refs/tags/v0.1.6 与 refs/tags/v0.1.6^{}（后者是它指向的提交）
```

### 步骤 6 · 建 GitHub Release（网页，6 小步）

Release 是"更新说明"的载体。**没有 Release，市场里只有版本号、没有说明。**

1. 打开（`?tag=` 会帮你预选，避免手滑选错 tag）：
   `https://github.com/yayuqianhuang/dsh-video-to-knowledge/releases/new?tag=v0.1.6`
2. 确认顶部 **Choose a tag** 下拉已是 `v0.1.6`（空就从列表里选；列表里没有 = 第 5 步没成功）
3. **Release title**：`v0.1.6`
4. **Describe this release**：粘 release notes（见下方模板）
5. 勾选 **Set as the latest release**
6. 点 **Publish release**

**不要碰的三样**：`Create new tag on publish`（tag 已有）、`Attach binaries`（插件不带附件）、
`Set as a pre-release`（正式版别勾）。

发布成功的标志：地址变成 `/releases/tag/v0.1.6`，且 `/releases` 页面上该条带 **Latest** 标签。

**release notes 模板**（直接改）：

```markdown
## v0.1.6

### 修复

- 一句话说清症状 + 根因（例：单 P 视频 `playlist_index` 渲染为 NA，导致字幕被丢弃）

### 新增

- 新工具 / 新能力

### 升级建议

装过的用户请手动「检查更新」或重装一次；旧版本不会自动升级。

---

遇到问题请提 issue（附插件版本 + 报错原文）：
https://github.com/yayuqianhuang/dsh-video-to-knowledge/issues
```

> ⚠️ **页脚是固定的，每个 Release 都必须带**（owner 要求）。
> 用户看完更新说明，下一步动作通常就是"我这儿出问题了"——把出口放在这里，比让他回 README 里翻更快。
> 上面模板那三行（`---` + 提示 + 链接）原样复制，别改措辞。

### 步骤 7 · 分发与验证

| 渠道 | 动作 |
|---|---|
| 插件市场 / `dsh plugin add` | 用户侧「检查更新」或重装；**旧版本不会自动升级** |
| 市场列表收录 | 首次需向 `awesome-dsh-plugin` 提 PR（见 §8），之后随版本自动反映 |
| npm（可选） | `npm publish --access public`，非必需 |

用户侧验收三条：

```bash
dsh plugin --profile web list | grep video-to-knowledge      # 版本号已变
npm test                                                     # 插件仓库里仍是 44 项通过
# 会话里说「我要 B 站登录」→ 应触发 vk_login
```

---

## 常见故障与修法

| 现象 | 原因 | 修法 |
|---|---|---|
| 市场提示"没有发布新版本号" | 只 push 提交、没升 `version` | 回到步骤 2 |
| 远端看不到 tag | `git push` 没带 `--follow-tags` | `git push origin v0.1.6` |
| tag 指到了旧提交 | 推送与重建 tag 撞车 | `git push origin refs/tags/v0.1.6 --force` |
| Release 选错了 tag | 手滑 | 编辑 Release 改 tag，或删了重建 |
| Release 建了但市场没说明 | 没勾 latest / 建成了 pre-release | 编辑 Release 修正 |
| 四个副本版本不一致 | 手改了多份 `package.json` | 以仓库为准，跑同步脚本 |

## 回滚一个坏版本

**优先"发新版本修"**，不要动已发布的 tag——用户可能已经装了。

```bash
# 推荐：0.1.6 有 bug → 修完发 0.1.7
```

如果刚发出去、确认没人装，可以撤：

```bash
git tag -d v0.1.6                    # 删本地 tag
git push origin :refs/tags/v0.1.6    # 删远端 tag
# 再去网页删掉对应 Release
```

## 一页速查

```bash
V=0.1.6
# 1. 改 package.json 的 version -> $V
npm test                                                    # 必须 SMOKE PASS
git add -A && git commit -m "chore(release): v$V"
git tag -a v$V -m "v$V"
git push origin main --follow-tags
git ls-remote --tags origin | grep "v$V"                    # 两行才算成功
# 2. 网页：/releases/new?tag=v$V → 标题 → 粘 notes → 勾 latest → Publish
```

## 已知限制

1. **必须自备 Python 3.10+ 与 yt-dlp**；插件不打包运行时。
2. **B 站部分视频需要登录 cookie**，插件只接受路径，不代管凭据。
3. `compileChunk` 是模型步骤：卡片正文由 agent 生成，链负责组装与校验；严格模式下会因此返回非 0。
4. 本地 ASR（无字幕视频兜底）需要 ffmpeg + faster-whisper，默认不启用。
5. vendored `engine/` 里还带着 AJTC 的其他链（模板/演示），保留是为了 `ajtc_*` 工具仍可用；
   如要极简，可只保留 `chains/video-to-knowledge` 与 `chains/governance`，但需同步改 `listChains()`。

---

## Release notes

### v0.1.0（首发）

**产物落点（重要）**

所有产出都写到 `outputDir`，默认 **`<工作区>/videoToKnowledge/`**：

```
<工作区>/videoToKnowledge/
├── kb/<collection>/   成品卡片 + 索引
├── runs/<videoId>/    中间产物（meta / transcript / clean / card.json / by_p）
└── cards/             模型写的卡片正文
```

三条规则（实测）：

| 情形 | 结果 |
|---|---|
| 默认，工作区不叫 `videoToKnowledge` | `<工作区>/videoToKnowledge/…`（追加一层） |
| 默认，工作区本身就叫 `videoToKnowledge` | 直接用工作区（**不再套一层**，避免双层目录） |
| 显式指定 `outputDir` | 原样使用，**不追加** |

> 从早期原型（`ajtc-chain-engine` 那套 mock 版，产物不落盘）迁移过来的人请注意：
> 现在会**在你的工作区里创建 `videoToKnowledge/` 目录**。
> 首次运行前可用 `vk_config {action:"set", key:"outputDir", value:"…"}` 改到你想要的位置。

**配置只有两项（+1 高级项）**

| 配置 | 必填 | 默认 | 环境变量 |
|---|---|---|---|
| `outputDir` | 否 | `<工作区>/videoToKnowledge/` | `VK_OUTPUT_DIR` |
| `cookiesPath` | 否 | 无（仅需要登录的视频才用） | `BILI_COOKIES` |
| `pythonPath` | 否 | 自动探测 | `VK_PYTHON` |

一次性的 `collection` / `mode` / `outlinePath` / `cardsDir` 走工具入参，不做成配置项。

**没有图形设置页**

dsh 的设置页必须由插件自带客户端 bundle 渲染（宿主不会从 Schema 自动生成），
本插件不发布客户端产物，因此也**不声明 `dsh.client`**（避免空声明）。
配置用 `vk_config`，`get` 会显示每个值的来源：
`[arg]` / `[env]` / `[file]` / `[workspace(session)]` / `[default]`。

**工具（7 个）**

`vk_doctor` / `vk_config` / `vk_prepare` / `vk_run`
\+ `ajtc_run_chain`（仅 mock）/ `ajtc_list_chains` / `ajtc_recall_memory`

**运行时要求**

Python 3.10+、yt-dlp；本地 ASR 另需 ffmpeg + faster-whisper；B 站受限视频需用户自备 cookie。
