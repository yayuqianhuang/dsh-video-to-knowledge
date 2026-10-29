# chains/governance

> **系统总论 / 政治认同（入口）**：先读 [`ajtc-creed.md`](./ajtc-creed.md) —— ajtc 引擎的「必修1」：从哪里来、走什么路、必须内化的政治认同，及落地四层闸门。

链治理 + 链扩展 + 安全助手 + 扩展回归夹具（合并归组）。

本文件夹包含 4 条触发链（按独立触发链归类）：

| 文件 | 链 id | 版本 | 标题 |
|------|-------|------|------|
| `_fixture_chain-extend.json` | `fixture.chain-extend` | 0.0.1 | 链扩展器回归夹具 |
| `gen.chain-extend.json` | `gen.chain-extend` | 0.1.0 | 链扩展器（元链：给已有链插入节点） |
| `gen.chain-governance.json` | `gen.chain-governance` | 0.2.0 | 链治理官 |
| `gen.security-assistant.json` | `gen.security-assistant` | 0.1.0 | 安全助手 |

## 运行

```bash
ajtc run <链id> --goal "<目标>"   # 或指定文件: ajtc run chains/governance/<文件> --goal "..."
ajtc lint <链id>                   # 静态检查
```

> 链通过 `id` 在 registry 注册，`ajtc` 命令按 id 解析，与文件所在子目录无关。
