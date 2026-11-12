#!/usr/bin/env python3
"""MiMo Token Plan 预算面板：今日预算 + 5 小时滚动窗口判断。

数据源（二选一，优先 tp- key）：
  1. Token Plan 专属 API Key（tp- 开头）→ GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan
  2. 平台 Cookie（控制台登录态）      → GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage

用法：
  budget.py show                 # 终端仪表盘
  budget.py watch [-n 60]        # 常驻刷新（放副屏/分栏）
  budget.py sample               # 只记录一次采样（给定时任务用）
  budget.py check                # 一行结论；退出码 0=可继续 2=建议暂停 3=无配置
  budget.py status --json        # 机器可读
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("MIMO_BUDGET_HOME", HOME / ".mimo-usage-budget"))
CONFIG_PATH = CONFIG_DIR / "config.json"
STATE_PATH = CONFIG_DIR / "state.json"

TP_URL = "https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan"
CONSOLE_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage"

DEFAULTS = {
    "tp_api_key": "",          # tp- 开头的 Token Plan 专属 key
    "cookie": "",              # 备用：platform.xiaomimimo.com 控制台 Cookie
    "window_hours": 5,         # 滚动窗口长度（小时）
    "pacing": "adaptive",      # adaptive=剩余量摊到剩余天数；fixed=总额度摊满整个周期
    "window_budget_override": 0,  # >0 时直接指定每窗口预算（Credits）
    "sample_keep_days": 8,
}

# ── config / state ──────────────────────────────────────────────


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except json.JSONDecodeError as e:
            die(f"配置文件损坏：{CONFIG_PATH}（{e}）")
    env_key = os.environ.get("MIMO_TP_API_KEY", "")
    if env_key and not cfg.get("tp_api_key"):
        cfg["tp_api_key"] = env_key
    return cfg


def die(msg: str, code: int = 3):
    print(msg, file=sys.stderr)
    sys.exit(code)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"samples": []}


def save_state(state: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE_PATH)


def append_sample(used_credits: float):
    """记录一次采样。只有 Token Plan 模型会推高 used_credits——
    免费/按量模型不增加该值，因此不会造成误触发。"""
    state = load_state()
    samples: list = state.setdefault("samples", [])
    now = time.time()
    samples.append({"t": now, "used": used_credits})
    cutoff = now - 86400 * 9
    state["samples"] = [s for s in samples if s["t"] >= cutoff]
    save_state(state)


# ── fetch ───────────────────────────────────────────────────────


def http_get(url: str, headers: dict) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        hint = "（tp- key 无效或过期）" if e.code == 401 else ""
        die(f"请求失败 HTTP {e.code} {hint}：{url} {body}")
    except urllib.error.URLError as e:
        die(f"网络错误：{e.reason}")


def fetch_plan(cfg: dict) -> dict:
    """统一成内部结构：
    {plan, period_start, period_end, total, used, remaining, source}
    单位一律 Credits。"""
    key = (cfg.get("tp_api_key") or "").strip()
    cookie = (cfg.get("cookie") or "").strip()

    if key:
        data = http_get(TP_URL, {"Authorization": f"Bearer {key}"})
        period = data.get("period") or {}
        quota = data.get("quota") or {}
        if "total_credits" not in quota:
            die(f"接口返回异常：{json.dumps(data)[:300]}")
        return {
            "plan": data.get("plan_code", "?"),
            "period_start": parse_dt(period.get("start_at", "")),
            "period_end": parse_dt(period.get("end_at", "")),
            "total": float(quota.get("total_credits", 0)),
            "used": float(quota.get("used_credits", 0)),
            "remaining": float(quota.get("remaining_credits", 0)),
            "source": "tp-api",
        }

    if cookie:
        data = http_get(
            CONSOLE_URL,
            {
                "Cookie": cookie,
                "Content-Type": "application/json",
                "x-timezone": datetime.now().astimezone().tzinfo.tzname(None) or "Asia/Shanghai",
            },
        )
        if data.get("code") != 0:
            die(f"控制台接口返回错误：{data.get('message', data)}")
        inner = data.get("data") or {}
        item = None
        for it in (inner.get("monthUsage") or {}).get("items") or []:
            if it.get("name") == "month_total_token":
                item = it
                break
        if item is None:
            items = (inner.get("usage") or {}).get("items") or []
            item = items[0] if items else None
        if item is None:
            die("控制台返回中没有用量项（可能未订阅套餐，或 Cookie 已过期）")
        used, total = float(item.get("used", 0)), float(item.get("limit", 0))
        now = datetime.now(timezone.utc)
        # 控制台口径没有周期边界，按自然月估算
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        next_month = (month_start + timedelta(days=32)).replace(day=1)
        return {
            "plan": "console",
            "period_start": month_start,
            "period_end": next_month,
            "total": total,
            "used": used,
            "remaining": max(0.0, total - used),
            "source": "console-cookie",
        }

    die(
        f"未配置凭证。请在 {CONFIG_PATH} 填入 tp_api_key（推荐，开放平台 Token Plan 页领取）"
        f" 或 cookie；也可设置环境变量 MIMO_TP_API_KEY。",
        3,
    )


def parse_dt(s: str) -> datetime:
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return datetime.now(timezone.utc)


# ── math ────────────────────────────────────────────────────────


def compute_metrics(plan: dict, cfg: dict, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    wh = float(cfg.get("window_hours") or 5)
    total, used, remaining = plan["total"], plan["used"], plan["remaining"]

    period_hours = max(1.0, (plan["period_end"] - plan["period_start"]).total_seconds() / 3600)
    hours_left = max(1.0, (plan["period_end"] - now).total_seconds() / 3600)
    days_left = hours_left / 24

    if cfg.get("pacing") == "fixed":
        daily_budget = total / (period_hours / 24)
    else:
        daily_budget = remaining / days_left if days_left > 0 else remaining

    override = float(cfg.get("window_budget_override") or 0)
    window_budget = override if override > 0 else daily_budget * (wh / 24)

    # ── 采样序列 → 今日用量 / 滚动窗口用量 / 恢复时间
    samples = sorted(load_state().get("samples", []), key=lambda s: s["t"])
    deltas = []
    prev = None
    for s in samples:
        if prev is not None:
            d = float(s["used"]) - float(prev["used"])
            if d > 0:
                deltas.append((s["t"], d))
        prev = s

    local = datetime.now().astimezone()
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    today_used = sum(d for t, d in deltas if t >= midnight)
    today_note = ""
    if not samples:
        today_note = "（无采样，先运行 sample）"
    elif samples[0]["t"] > midnight:
        today_note = "（今日起点采样缺失，数值偏小）"

    win_start = now.timestamp() - wh * 3600
    in_win = [(t, d) for t, d in deltas if t > win_start]
    window_used = sum(d for _, d in in_win)

    verdict, resume_at = "ok", None
    if window_budget > 0 and window_used > window_budget:
        verdict = "pause"
        acc, resume_ts = 0.0, in_win[-1][0] if in_win else now.timestamp()
        for t, d in in_win:  # 从最旧的消耗开始“滑出”
            acc += d
            if window_used - acc <= window_budget:
                resume_ts = t
                break
        resume_at = resume_ts + wh * 3600

    return {
        "plan": plan["plan"],
        "source": plan["source"],
        "period_start": plan["period_start"].isoformat(),
        "period_end": plan["period_end"].isoformat(),
        "hours_left": round(hours_left, 2),
        "month": {
            "used": used,
            "total": total,
            "remaining": remaining,
            "pct": (used / total) if total else 0.0,
        },
        "today": {
            "used": today_used,
            "budget": daily_budget,
            "pct": (today_used / daily_budget) if daily_budget else 0.0,
            "note": today_note,
        },
        "window": {
            "hours": wh,
            "used": window_used,
            "budget": window_budget,
            "pct": (window_used / window_budget) if window_budget else 0.0,
        },
        "verdict": verdict,
        "resume_at": datetime.fromtimestamp(resume_at, tz=timezone.utc).isoformat() if resume_at else None,
        "resume_at_local": (
            datetime.fromtimestamp(resume_at).astimezone().strftime("%H:%M") if resume_at else None
        ),
        "samples": len(samples),
        "generated_at": now.isoformat(),
        "cost_note": "仅 Token Plan 模型消耗额度；免费/按量模型不计入，不会误触发",
    }


# ── render ──────────────────────────────────────────────────────


def fmt_credits(v: float) -> str:
    av = abs(v)
    if av >= 1e8:
        return f"{v / 1e8:.2f}亿"
    if av >= 1e4:
        return f"{v / 1e4:.1f}万"
    return f"{v:.0f}"


def bar(pct: float, width: int = 14) -> str:
    pct = max(0.0, min(1.0, pct))
    filled = round(pct * width)
    return "█" * filled + "░" * (width - filled)


def render_dashboard(m: dict) -> str:
    lines = []
    lines.append("╭─ MiMo Token Plan 预算面板 " + "─" * 28)
    lines.append(
        f"│ 套餐 {m['plan']} · 周期剩 {m['hours_left']:.1f}h · 采样 {m['samples']} 点"
    )
    mo = m["month"]
    lines.append(
        f"│ 本月 [{bar(mo['pct'])}] {mo['pct'] * 100:5.1f}%  "
        f"{fmt_credits(mo['used'])} / {fmt_credits(mo['total'])} Credits"
    )
    td = m["today"]
    lines.append(
        f"│ 今日 [{bar(td['pct'])}] {td['pct'] * 100:5.1f}%  "
        f"{fmt_credits(td['used'])} / {fmt_credits(td['budget'])} (日预算){td['note']}"
    )
    wd = m["window"]
    lines.append(
        f"│ {wd['hours']:.0f}h窗 [{bar(wd['pct'], 12)}] {wd['pct'] * 100:5.1f}%  "
        f"{fmt_credits(wd['used'])} / {fmt_credits(wd['budget'])} (窗口预算)"
    )
    if m["verdict"] == "ok":
        lines.append("│ 状态 ✅ 低于窗口预算，可继续")
    else:
        lines.append(
            f"│ 状态 ⏸️  已超 {wd['hours']:.0f}h 窗口预算，建议停到 "
            f"{m['resume_at_local']}（窗口滑动恢复，非真实重置）"
        )
    lines.append("│ " + m["cost_note"])
    lines.append("╰" + "─" * 52)
    return "\n".join(lines)


# ── commands ────────────────────────────────────────────────────


def cmd_show(cfg):
    plan = fetch_plan(cfg)
    append_sample(plan["used"])
    print(render_dashboard(compute_metrics(plan, cfg)))


def cmd_sample(cfg):
    plan = fetch_plan(cfg)
    append_sample(plan["used"])
    print(f"sampled used={plan['used']:.0f}")


def cmd_check(cfg):
    plan = fetch_plan(cfg)
    append_sample(plan["used"])
    m = compute_metrics(plan, cfg)
    if m["verdict"] == "ok":
        print(
            f"OK 5h窗口 {m['window']['pct'] * 100:.0f}% · 今日 {m['today']['pct'] * 100:.0f}% · "
            f"本月 {m['month']['pct'] * 100:.1f}%"
        )
        sys.exit(0)
    print(
        f"PAUSE 已超 {m['window']['hours']:.0f}h 窗口预算，建议停到 {m['resume_at_local']}"
    )
    sys.exit(2)


def cmd_status(cfg):
    plan = fetch_plan(cfg)
    append_sample(plan["used"])
    print(json.dumps(compute_metrics(plan, cfg), ensure_ascii=False, indent=2))


def cmd_watch(cfg, interval: float):
    try:
        while True:
            plan = fetch_plan(cfg)
            append_sample(plan["used"])
            m = compute_metrics(plan, cfg)
            os.system("clear" if os.name != "nt" else "cls")
            print(render_dashboard(m))
            print(f"（{interval:.0f}s 刷新一次，Ctrl+C 退出 · {datetime.now():%H:%M:%S}）")
            time.sleep(interval)
    except KeyboardInterrupt:
        pass


def main():
    p = argparse.ArgumentParser(description="MiMo Token Plan 预算面板")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("show")
    sub.add_parser("sample")
    sub.add_parser("check")
    sub.add_parser("status").add_argument("--json", action="store_true")
    w = sub.add_parser("watch")
    w.add_argument("-n", "--interval", type=float, default=60)
    args = p.parse_args()
    cfg = load_config()

    {"show": cmd_show, "sample": cmd_sample, "check": cmd_check, "status": cmd_status,
     "watch": lambda c: cmd_watch(c, args.interval), None: cmd_show}[args.cmd](cfg)


if __name__ == "__main__":
    main()
