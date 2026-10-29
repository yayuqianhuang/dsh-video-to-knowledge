# chains/identity-bootstrap

身份初始化引导链。

本文件夹包含 1 条触发链（按独立触发链归类）：

| 文件 | 链 id | 版本 | 标题 |
|------|-------|------|------|
| `gen.identity-bootstrap.json` | `gen.identity-bootstrap` | 0.3.0 | 身份初始化引导（init 表单 + apply 落盘 + 收尾删引导文件） |

## 运行

```bash
ajtc run <链id> --goal "<目标>"   # 或指定文件: ajtc run chains/identity-bootstrap/<文件> --goal "..."
ajtc lint <链id>                   # 静态检查
```

> 链通过 `id` 在 registry 注册，`ajtc` 命令按 id 解析，与文件所在子目录无关。
