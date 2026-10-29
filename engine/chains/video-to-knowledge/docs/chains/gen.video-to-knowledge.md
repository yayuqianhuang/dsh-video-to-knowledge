# 链文档：gen.video-to-knowledge（视频链接转知识库）

> 配套 SDD：`<your-sdd-path>/02-需求开发说明书-video-to-knowledge.md`（可选，由使用者自行维护）
> 链定义目录：`chains/video-to-knowledge/`
> 版本：v0.1.0 · tier: tool · 责任人：User (Tech Lead)（L-GOV-025）

---

## 1. 一句话定位

把任意视频链接编译成**带时间戳、可回跳、可复盘**的 Markdown 知识卡片，幂等落盘到本地 `kb/<collection>/` 文件夹。**检索/向量化/重排交由 WorkBuddy 工作台承载（D9）**，本链只负责「视频 → 知识卡」离线编译这一段。

## 2. 主链拓扑（14 节点）

```
intake → redlines → validateInput
  → (invalid/fail) bail
  → probeEnv → [getCredential] → envGate → (fail) bail
  → prepare(子链) → (failed) bail
  → qualityGate → (fail) bail
  → dedupeCheck → (abort) bail
  → confirmGate → (hold) deliver
  → uploadLoop(子链) → verify → deliver
```

| # | 节点 | kind/use | 职责 |
|---|---|---|---|
| 1 | `intake` | fn/set | 归一化入参（mode 默认 dryRun，lang 默认 zh-CN，collection 默认 default） |
| 2 | `redlines` | fn/redlines | 红线/意图护栏（SSOT: iron-laws.json） |
| 3 | `validateInput` | gate | url/kbPath 非空 + 平台可识别 |
| 4 | `bail` | fn/deliver | 任一前置失败收口（0 副作用，halt） |
| 5 | `probeEnv` | fn/agentStep | 依赖 + 登录态自检；B 站场景 emit `probeEnv.needsBili` |
| 6 | `getCredential` | fn/agentStep | SESSDATA 仓库外读取 + 仅注入子进程 env（D3） |
| 7 | `envGate` | gate | missing[] 空且 biliLogin=valid → proceed |
| 8 | `prepare` | chain | 子链 `gen.video-to-knowledge.prepare`（pick: card） |
| 9 | `qualityGate` | gate | 结构/时间戳/字数/敏感词/占位符 |
| 10 | `dedupeCheck` | fn/agentStep | video_id + content_hash 双键查重，产出 uploadQueue |
| 11 | `confirmGate` | gate | dryRun 或需确认 → hold；否则 upload |
| 12 | `uploadLoop` | map | 逐文件落盘（子链 `gen.video-to-knowledge.upload`） |
| 13 | `verify` | fn/agentStep | kb 文件夹文档计数增量核验（无向量索引） |
| 14 | `deliver` | fn/deliver | 完成包（narrative + evidence，halt） |

## 3. 子链职责

| 子链 | 节点 | 说明 |
|---|---|---|
| `gen.video-to-knowledge.prepare` | fetchMeta → acquireTranscript → transcriptGate → cleanTranscript → compileLoop → synthesize | 元数据→字幕三级回退→脚本清洗→分块编译→综述，产出 `$.card` |
| `gen.video-to-knowledge.chunk` | chunkIntake → redlines → compileChunk → assertTimestamps | 单块 LLM 编译 + 时间戳白名单闸门（剔除段表外伪造时间戳） |
| `gen.video-to-knowledge.upload` | redlines → storeChunk → storeGate | 单文件落盘（写 .md + 元数据 JSON），只增不删 |

## 4. 关键外部依赖

| 依赖 | 用途 | 强制 |
|---|---|---|
| `yt-dlp` | 抓元数据（`-J`）/ 字幕 / 音频 | 必需 |
| `ffmpeg` | 音频抽取（ASR 路径） | ASR 路径必需 |
| `faster-whisper` | 本地转录兜底（T3） | T3 开启时必需（默认关） |
| `~/.workbuddy/secrets/bili-sessdata` | B 站 SESSDATA（仅注入子进程 env） | B 站必需 |
| `scripts/clean_transcript.py` | 脚本清洗 + 脱敏 + 切块 | 必需（已落地） |

> 引擎以 `process.cwd()`（仓库根）解析相对路径，`prepare.json` 调 `python scripts/clean_transcript.py` 即指向 `仓库根/scripts/`。

## 5. 数据契约（要点）

- **卡片模板**：见 SDD §5.1（frontmatter 含 video_id / duration_sec / content_hash / storage_mode 等；正文带 `[mm:ss]` + `source_url#t=秒` 深链）。
- **clean.jsonl**：`{idx, startSec, endSec, text}`，时间戳为唯一真相。
- **manifest / runs**：`runs/<videoId>/` 落盘 meta / transcript / clean / chunks / card，支持 `--force` 重做。

## 6. 回归测试（链内声明）

| ID | 类型 | 期望 |
|---|---|---|
| RT-VK-1 | happy(dryRun) | 出卡片、质量门 pass、0 落盘 |
| RT-VK-2 | happy(upload) | kb 文档 +1、verify.ok |
| RT-VK-3 | edge(重复) | dedupe.hit、skipped、计数不变 |
| RT-VK-4 | edge(坏 URL) | INVALID_URL → bail |
| RT-VK-5 | edge(无字幕+T3关) | NO_TRANSCRIPT → bail |
| RT-VK-6 | edge(SESSDATA失效) | LOGIN_REQUIRED → bail |
| RT-VK-7 | negative(伪造时间戳) | 剔除、dropped>0 |
| RT-VK-8 | negative(含手机号) | quality.fail、0 落盘 |

## 7. 治理约束（红线）

- 删除 kb 既有卡片 / 覆盖既有卡片 / 下载转存音视频 / 分发版权媒体 / SESSDATA 进黑板日志 git / 上传未指定 kbPath / 自建向量索引 / 调 embedding 端点 —— 全部命中 `redlines` 节点拦截。

## 8. 当前落地状态（2026-10-27）

- ✅ 4 条链 JSON 完整（主链 + 3 子链），含 principle / acceptance / regressionTests / governance。
- ✅ `scripts/clean_transcript.py` 已补齐并通过自测（PII 脱敏 / 口癖剥离 / 短段合并 / 乱序时间戳保序不重排 / 3000 字切块 / <300 字早停）。
- ✅ `SKILL.md` / 本链文档已补齐。
- ⚠️ 尚未实跑过：M0 环境门（依赖/SESSDATA/目录）需人工就位后用 `dryRun`（RT-VK-1）首跑验证。
