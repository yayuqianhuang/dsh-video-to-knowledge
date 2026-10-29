# chains/summarize

事实优先摘要链。

本文件夹包含 1 条触发链（按独立触发链归类）：

| 文件 | 链 id | 版本 | 标题 |
|------|-------|------|------|
| `gen.summarize.json` | `gen.summarize` | 0.3.0 | 事实优先摘要链 |

## 运行

```bash
ajtc run <链id> --goal "<目标>"   # 或指定文件: ajtc run chains/summarize/<文件> --goal "..."
ajtc lint <链id>                   # 静态检查
```

> 链通过 `id` 在 registry 注册，`ajtc` 命令按 id 解析，与文件所在子目录无关。
