#!/usr/bin/env bash
# mimo-usage-budget 安装脚本：/budget 命令 + TUI 侧栏插件 + 定时采样
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MIMO_CFG="${HOME}/.config/mimocode"
BUDGET_HOME="${HOME}/.mimo-usage-budget"

echo "==> 1/4 创建配置目录"
mkdir -p "$BUDGET_HOME" "$MIMO_CFG/command"
if [ ! -f "$BUDGET_HOME/config.json" ]; then
  cp "$ROOT/config.example.json" "$BUDGET_HOME/config.json"
  echo "    已生成 $BUDGET_HOME/config.json —— 请填入 tp_api_key（tp- 开头）"
else
  echo "    配置已存在，跳过"
fi

echo "==> 2/4 安装 /budget 提示命令（插件未加载时的后备）"
cp "$ROOT/command/budget.md" "$MIMO_CFG/command/budget.md"
echo "    -> $MIMO_CFG/command/budget.md"

echo "==> 3/4 安装 TUI 侧栏插件（mimo plugin，自动登记 tui.json）"
MIMO_BIN="${MIMOCODE_BIN:-$HOME/.mimocode/bin/mimo}"
if [ -x "$MIMO_BIN" ]; then
  "$MIMO_BIN" plugin "$ROOT/plugin" -g || {
    echo "    安装失败，可手动执行：mimo plugin $ROOT/plugin -g"
  }
else
  echo "    未找到 mimo（默认 $MIMO_BIN），跳过插件安装（/budget 命令仍可用）"
  echo "    手动安装：mimo plugin $ROOT/plugin -g"
fi

echo "==> 4/4 可选：定时采样（launchd，每 10 分钟记录一次用量，供 5h 窗口计算）"
read -r -p "    是否安装定时采样？[y/N] " yn
if [ "${yn:-N}" = "y" ] || [ "${yn:-N}" = "Y" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.mimo-usage-budget.sample.plist"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mimo-usage-budget.sample</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$ROOT/budget.py</string>
    <string>sample</string>
  </array>
  <key>StartInterval</key><integer>600</integer>
  <key>StandardErrorPath</key><string>$BUDGET_HOME/sample.err</string>
</dict>
</plist>
PLIST
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "    已加载 $PLIST"
fi

echo "完成。运行 python3 $ROOT/budget.py show 查看面板。"
