---
description: 显示 MiMo Token Plan 今日预算与 5 小时窗口判断（不消耗模型额度的本地脚本）
---

运行下面这条本地命令，并把输出原样展示给我，不要做任何额外分析：

```bash
python3 __BUDGET_ROOT__/budget.py show
```

如果脚本报「未配置凭证」，告诉我去 `~/.mimo-usage-budget/config.json` 填 `tp_api_key`。
