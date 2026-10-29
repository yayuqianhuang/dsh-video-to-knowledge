# chains/explainer

统一解释链（术语 / 概念 W5H）。

本文件夹包含 1 条触发链（按独立触发链归类）：

| 文件 | 链 id | 版本 | 标题 |
|------|-------|------|------|
| `gen.explainer.json` | `gen.explainer` | 0.3.0 | 统一解释链（术语 / 概念 W5H） |

## 运行

```bash
ajtc run <链id> --goal "<目标>"   # 或指定文件: ajtc run chains/explainer/<文件> --goal "..."
ajtc lint <链id>                   # 静态检查
```

> 链通过 `id` 在 registry 注册，`ajtc` 命令按 id 解析，与文件所在子目录无关。
