# chains/core

引擎基础设施链（自举 / 记忆），非业务触发链，单独隔离。

本文件夹包含 2 条触发链（按独立触发链归类）：

| 文件 | 链 id | 版本 | 标题 |
|------|-------|------|------|
| `memory-store.json` | `memory.store` | 0.2.0 | 项目记忆触发链（MEMORY.md 结构化 offload 目标） |
| `sys.genesis.json` | `sys.genesis` | 1.2.0 | 元链 · 生成并初始化其他触发链 |

## 运行

```bash
ajtc run <链id> --goal "<目标>"   # 或指定文件: ajtc run chains/core/<文件> --goal "..."
ajtc lint <链id>                   # 静态检查
```

> 链通过 `id` 在 registry 注册，`ajtc` 命令按 id 解析，与文件所在子目录无关。
