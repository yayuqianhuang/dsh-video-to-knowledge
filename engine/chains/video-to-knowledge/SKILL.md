---
name: video-to-knowledge
description: 把视频链接（B 站为主）编译成带时间戳、可回跳、可复盘的 Markdown 知识卡片，幂等落盘到本地 kb/<collection>/ 文件夹。检索/向量化/重排由 WorkBuddy 工作台承载（D9 决策），本技能只负责「视频 → 知识卡」这一段离线编译。当用户粘贴视频链接、希望把视频内容沉淀为可检索的带时间戳知识卡片时使用。
version: 0.1.0
chain: gen.video-to-knowledge
tier: tool
---

# 技能：video-to-knowledge（视频链接转知识卡）

## 一、它做什么

输入一条视频链接（B 站为主，YouTube 条件支持），自动完成：

```
链接 → 环境自检 → 抓元数据 → 取字幕（三级回退）→ 脚本清洗 → 分块编译 → 全局综述
     → 质量门 → 查重 → （确认后）落盘 Markdown 卡片到 kb/<collection>/
```

**边界（D9）**：本技能**只落盘 Markdown 知识卡**，不建向量索引、不调 embedding、不提供对话/检索 UI；卡片的 `[mm:ss]` 锚点 + `source_url#t=秒` 深链供 WorkBuddy 工作台检索后人工回跳原视频。

## 二、什么时候用

- 用户说"把这个视频变成知识卡片""沉淀这个 B 站视频""把链接转成可检索笔记"。
- 用户已在 WorkBuddy 工作台，想把视频内容入库后检索/追问。

## 三、怎么触发（入口）

通过 AJTC 引擎运行主链 `gen.video-to-knowledge`，入参：

```json
{
  "url": "https://www.bilibili.com/video/BV1xx411c7mD",
  "kbPath": "<workDir>/kb",
  "collection": "bilibili",
  "lang": "zh-CN",
  "mode": "dryRun"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | 支持 `bilibili.com/video/BV…`、`b23.tv` 短链、`youtube.com/watch?v=`、`youtu.be/` |
| `kbPath` | 是 | 知识库根目录（绝对路径） |
| `collection` | 否 | 集合名（kbPath 下子目录），默认 `default`；命名用 lowercase/数字/连字符 |
| `lang` | 否 | 默认 `zh-CN` |
| `mode` | 否 | `dryRun`（默认，跑完不落盘只出清单）/ `upload`（确认后真写） |

> **首次运行必须 `dryRun`**：出清单交人确认后再切 `upload`，防脏数据。

## 四、强制约束（铁律，不可绕过）

1. **时间戳只来自字幕/ASR 原始数据**，LLM 不得生成或改写；编译阶段只能"引用"段表内的 `[mm:ss]`。
2. **早停**：依赖缺失、登录失效（SESSDATA）、字幕缺失 → 在烧 token 之前终止，0 次落盘。
3. **查重前置**：落盘前按 `video_id + content_hash` 双键比对，查不了就不写（宁可失败不产脏数据）。
4. **只增不删**：默认不覆盖/不删除 kb 文件夹既有卡片；同名冲突走 `-v2` 版本后缀。
5. **SESSDATA 安全（D3）**：从仓库外 `~/.workbuddy/secrets/bili-sessdata` 读取，**仅注入 yt-dlp 子进程 env**，绝不进黑板/LLM/日志/git；优先用低权限小号。
6. **不下载/转存/分发**受版权保护的媒体文件；音频为临时转录输入，任务结束删除。
7. **证据分层**：模型的 `narrative` 只是叙述层；`evidence` 字段（字数/段数/覆盖率/字节数/哈希）由脚本产出的机器事实，模型不得改写。

## 五、子链构成（执行单元）

| 链 | 角色 |
|---|---|
| `gen.video-to-knowledge` | 主链：14 节点编排 |
| `gen.video-to-knowledge.prepare` | 素材准备：元数据→字幕→清洗→分块编译→综述 |
| `gen.video-to-knowledge.chunk` | 单块编译 + 时间戳白名单闸门 |
| `gen.video-to-knowledge.upload` | 单文件落盘（仅存储） |

## 六、M0 硬前置（运行前必须就位）

- `yt-dlp`（字幕/元数据必需）、`ffmpeg`（ASR 路径必需）、`faster-whisper`（T3 本地转录必需，默认关）；
- SESSDATA 文件 `~/.workbuddy/secrets/bili-sessdata`（`chmod 600`，仅 B 站小号）；
- `kbPath`/`collection` 目录（首跑按配置自动建）。

## 七、产出形态

- 知识卡：`kb/<collection>/<videoId>.md`（含 frontmatter + 一句话结论 + 核心要点[带 mm:ss] + 章节时间轴 + 关键概念 + 存疑清单）；
- 元数据 JSON：同名同目录；
- 中间产物：`runs/<videoId>/`（meta / transcript / clean / chunks / card），支持断点续跑。

## 八、失败语义（命名错误码）

`INVALID_URL` / `ENV_MISSING` / `LOGIN_REQUIRED` / `NO_TRANSCRIPT` / `TRANSCRIPT_TOO_SHORT` / `QUALITY_GATE_FAIL` / `DEDUP_ABORT` / `UPLOAD_PARTIAL`。任一前置门失败 → `bail` 收口，0 次落盘。
