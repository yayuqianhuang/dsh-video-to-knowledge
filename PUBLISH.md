# PUBLISH.md — 把 dsh-video-to-knowledge 发布为 dsh 插件

本文件是给**你（仓库 owner）**的发布 runbook。插件本体已完成代码卫生、跨平台化与冒烟测试，
剩下的步骤需要在**你的机器/你的账号**上执行（涉及 GitHub 鉴权、`dsh` 安装、真实联网验证）。

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

## 版本与发布（市场只认"正式版本"）

**现象**：推了新提交，但市场提示：

> 所选分支上有比你已装版本更新的提交，但没有发布新版本号；市场只安装正式版本，不会自动装这些提交。

**原因**：市场按**版本号**判断有没有更新。只 push 提交而不改 `package.json` 的 `version`，
市场就认为你已经是最新；即使分支上有更新的提交也不会装。

**发布一个版本的完整动作**：

```bash
# 0) 确认工作区干净
git status

# 1) 升版本（语义化：修 bug = patch，新功能 = minor，破坏性变更 = major/minor）
#    直接改 package.json 里的 "version"

# 2) 提交
git add -A
git commit -m "chore(release): v0.1.1"

# 3) 打 annotated tag
git tag -a v0.1.1 -m "dsh-video-to-knowledge v0.1.1"

# 4) 推提交与 tag（注意 --follow-tags）
git push origin main --follow-tags

# 5) 网页上建 Release：选刚推的 tag，贴 release notes
```

> ⚠️ `git push` **默认不推 tag**。不写 `--follow-tags`（或单独 `git push origin v0.1.1`），
> tag 就只在本地，市场侧看不到"新版本"。

**验证**：

```bash
git ls-remote --tags origin     # 远端应出现 refs/tags/v0.1.1
```

市场里点「检查更新」应出现新版本号。**已安装的旧版本不会自动升级**，需要手动更新或重装一次。

**版本号放在哪**：只放 `package.json` 的 `version`。`cordis.patch.yml` 不写版本；
README 里的"当前版本"是给人看的，可随手同步。

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
