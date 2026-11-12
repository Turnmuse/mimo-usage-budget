/**
 * mimo-usage-budget-plugin — MiMo Token Plan 预算侧栏（今日预算 + 5h 滚动窗口判断）
 *
 * 结构与 TUI 插件 API 用法参考了 MIT 协议的
 * Enderman112/mimo-ds-usage-monitor（Copyright (c) xuyaoshi），在此致谢；
 * 该参考部分仍按 MIT 提供，本项目其余部分按 PolyForm Noncommercial 1.0.0（见 LICENSE）。
 *
 * 与 budget.py 共享配置：~/.mimo-usage-budget/config.json（tp_api_key / cookie / window_hours）
 * 采样记录尽力写入 ~/.mimo-usage-budget/state.json，不可写时回退到插件 kv。
 */
/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiSlotContext,
  TuiSlotPlugin,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@mimo-ai/plugin/tui"
import { createSignal, createMemo, Show, onMount, onCleanup } from "solid-js"

const TP_URL = "https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan"
const CONSOLE_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage"

// ── fs helpers（沙箱里不可用时静默降级） ──

function fsAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs")
    const os = require("node:os") as typeof import("node:os")
    const path = require("node:path") as typeof import("node:path")
    const dir = path.join(os.homedir(), ".mimo-usage-budget")
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

function readConfigFile(): { tp_api_key?: string; cookie?: string; window_hours?: number } {
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    const os = require("node:os") as typeof import("node:os")
    const path = require("node:path") as typeof import("node:path")
    const p = path.join(os.homedir(), ".mimo-usage-budget", "config.json")
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"))
  } catch {}
  return {}
}

function appendSampleToState(used: number): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    const os = require("node:os") as typeof import("node:os")
    const path = require("node:path") as typeof import("node:path")
    const p = path.join(os.homedir(), ".mimo-usage-budget", "state.json")
    let state: { samples: Array<{ t: number; used: number }> } = { samples: [] }
    if (fs.existsSync(p)) state = JSON.parse(fs.readFileSync(p, "utf-8"))
    state.samples = state.samples || []
    state.samples.push({ t: Date.now() / 1000, used })
    const cutoff = Date.now() / 1000 - 86400 * 9
    state.samples = state.samples.filter((s) => s.t >= cutoff)
    fs.writeFileSync(p, JSON.stringify(state))
  } catch {}
}

function readSamplesFromState(): Array<{ t: number; used: number }> {
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    const os = require("node:os") as typeof import("node:os")
    const path = require("node:path") as typeof import("node:path")
    const p = path.join(os.homedir(), ".mimo-usage-budget", "state.json")
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8")).samples || []
  } catch {}
  return []
}

// ── fetch ──

interface PlanInfo {
  plan: string
  total: number
  used: number
  remaining: number
  hoursLeft: number
}

async function fetchPlan(api: TuiPluginApi): Promise<{ plan?: PlanInfo; error?: string }> {
  const cfg = readConfigFile()
  const tpKey = cfg.tp_api_key || api.kv.get<string>("mimo-usage-budget.tpKey", "")
  const cookie = cfg.cookie || api.kv.get<string>("mimo-usage-budget.cookie", "")
  try {
    if (tpKey) {
      const res = await fetch(TP_URL, { headers: { Authorization: `Bearer ${tpKey}` } })
      if (!res.ok) return { error: `HTTP ${res.status}${res.status === 401 ? "（tp- key 无效）" : ""}` }
      const data = await res.json()
      const q = data.quota || {}
      const end = Date.parse((data.period?.end_at || "").replace(" ", "T") + "Z") || Date.now()
      return {
        plan: {
          plan: data.plan_code || "?",
          total: q.total_credits ?? 0,
          used: q.used_credits ?? 0,
          remaining: q.remaining_credits ?? 0,
          hoursLeft: Math.max(1, (end - Date.now()) / 3600000),
        },
      }
    }
    if (cookie) {
      const res = await fetch(CONSOLE_URL, {
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          "x-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      })
      if (!res.ok) return { error: `HTTP ${res.status}${res.status === 401 ? "（Cookie 已过期）" : ""}` }
      const json = await res.json()
      if (json.code !== 0) return { error: json.message || "请求失败" }
      const items = json.data?.monthUsage?.items || json.data?.usage?.items || []
      const item = items.find((i: any) => i.name === "month_total_token") || items[0]
      if (!item) return { error: "无用量项（未订阅套餐或 Cookie 过期）" }
      return {
        plan: {
          plan: "console",
          total: item.limit ?? 0,
          used: item.used ?? 0,
          remaining: Math.max(0, (item.limit ?? 0) - (item.used ?? 0)),
          hoursLeft: 24 * 30,
        },
      }
    }
    return { error: "未配置凭证：/budget-key 设置 tp- key，或运行 budget.py 配置" }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "网络错误" }
  }
}

// ── math（与 budget.py 保持一致） ──

interface Metrics {
  monthPct: number
  todayUsed: number
  todayBudget: number
  winUsed: number
  winBudget: number
  winHours: number
  verdict: "ok" | "pause"
  resumeLocal: string | null
  used: number
  total: number
  /** 距最近一次采样的秒数；>15 分钟视为采样陈旧（TUI 关闭或采样中断） */
  staleSec: number
  todayNote: string
}

function compute(plan: PlanInfo, winHours: number): Metrics {
  const dayBudget = plan.remaining / Math.max(1 / 24, plan.hoursLeft / 24)
  const winBudget = dayBudget * (winHours / 24)

  // 累计计数器 + 线性插值（与 budget.py 一致）。
  // 不要用相邻差值求和：断档期间的消耗会被整段记到「恢复采样那一刻」，
  // 导致断档时显示 0%、恢复后瞬间爆表。
  const samples = readSamplesFromState().slice().sort((a, b) => a.t - b.t)

  const usedAt = (ts: number): number | null => {
    if (!samples.length) return null
    if (ts <= samples[0].t) return samples[0].used
    if (ts >= samples[samples.length - 1].t) return samples[samples.length - 1].used
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]
      const b = samples[i]
      if (a.t <= ts && ts <= b.t) {
        if (b.used <= a.used) return a.used // 计数器回绕（套餐周期重置）：不跨回绕插值
        if (b.t === a.t) return b.used
        return a.used + (b.used - a.used) * ((ts - a.t) / (b.t - a.t))
      }
    }
    return samples[samples.length - 1].used
  }

  const tsAtUsed = (target: number): number | null => {
    if (!samples.length) return null
    if (target <= samples[0].used) return samples[0].t
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]
      const b = samples[i]
      if (b.used <= a.used) continue
      if (a.used <= target && target <= b.used) {
        if (b.used === a.used) return b.t
        return a.t + (b.t - a.t) * ((target - a.used) / (b.used - a.used))
      }
    }
    return samples[samples.length - 1].t
  }

  const nowSec = Date.now() / 1000
  const winStart = nowSec - winHours * 3600
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)

  const latest = samples.length ? samples[samples.length - 1].used : 0
  const dayBase = usedAt(midnight.getTime() / 1000)
  const winBase = usedAt(winStart)
  const todayUsed = dayBase === null ? 0 : Math.max(0, latest - dayBase)
  const winUsed = winBase === null ? 0 : Math.max(0, latest - winBase)

  let todayNote = ""
  if (!samples.length) todayNote = "（无采样）"
  else if (samples[0].t > midnight.getTime() / 1000) todayNote = "（起点无采样，外推偏大）"

  const staleSec = samples.length ? Math.max(0, nowSec - samples[samples.length - 1].t) : Infinity

  let verdict: "ok" | "pause" = "ok"
  let resumeLocal: string | null = null
  if (winBudget > 0 && winUsed > winBudget) {
    verdict = "pause"
    const hit = tsAtUsed(latest - winBudget) ?? nowSec
    const dt = new Date((hit + winHours * 3600) * 1000)
    resumeLocal = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`
  }

  return {
    monthPct: plan.total ? plan.used / plan.total : 0,
    todayUsed,
    todayBudget: dayBudget,
    winUsed,
    winBudget,
    winHours,
    verdict,
    resumeLocal,
    used: plan.used,
    total: plan.total,
    staleSec,
    todayNote,
  }
}

// ── display helpers ──

function fmtCredits(v: number): string {
  const av = Math.abs(v)
  if (av >= 1e8) return (v / 1e8).toFixed(2) + "亿"
  if (av >= 1e4) return (v / 1e4).toFixed(1) + "万"
  return String(Math.round(v))
}

function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, percent))
  const filled = Math.round(clamped * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function isXiaomiProvider(api: TuiPluginApi, sessionId: string): boolean {
  try {
    const msgs = api.state.session.messages(sessionId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i] as any
      if (msg.role === "assistant" && msg.providerID) {
        const pid = String(msg.providerID).toLowerCase()
        return pid.includes("xiaomi") || pid.includes("mimo")
      }
    }
    for (const p of api.state.provider) {
      const pid = String(p.id).toLowerCase()
      if (pid.includes("xiaomi") || pid.includes("mimo")) return true
    }
  } catch {}
  return false
}

// ── panel ──

function BudgetPanel(props: {
  theme: TuiThemeCurrent
  api: TuiPluginApi
  sessionId: string
}): JSX.Element {
  const [open, setOpen] = createSignal(true)
  const [metrics, setMetrics] = createSignal<Metrics | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const isXiaomi = createMemo(() => isXiaomiProvider(props.api, props.sessionId))

  const refresh = async () => {
    const cfg = readConfigFile()
    const wh = Number(cfg.window_hours || props.api.kv.get<number>("mimo-usage-budget.windowHours", 5)) || 5
    const r = await fetchPlan(props.api)
    if (r.plan) {
      appendSampleToState(r.plan.used)
      setMetrics(compute(r.plan, wh))
      setError(null)
    } else if (r.error) {
      setError(r.error)
    }
  }

  onMount(() => {
    refresh()
    const iv = setInterval(refresh, 60_000)
    onCleanup(() => clearInterval(iv))
  })

  const hitColor = (p: number, ok: string, warn: string, bad: string) =>
    p > 1 ? bad : p > 0.75 ? warn : ok

  return (
    <box border borderColor="gray" paddingLeft={2} paddingRight={2} flexDirection="column" gap={0}>
      <text onMouseUp={() => setOpen((o) => !o)}>
        <span fg="gray">{open() ? "▼ " : "▶ "}</span>
        <span>
          <b>MiMo 预算 (5h窗口)</b>
        </span>
      </text>
      <Show when={open()}>
        <Show
          when={isXiaomi()}
          fallback={<text fg="gray">当前模型不计入套餐，不误报</text>}
        >
          <Show
            when={!error()}
            fallback={<text fg="yellow">{"> " + error()}</text>}
          >
            <Show when={metrics()}>
              {(m) => (
                <>
                  <text>
                    <span>本月 </span>
                    <span fg={hitColor(m().monthPct, "green", "yellow", "red")}>
                      [{progressBar(m().monthPct, 10)}] {(m().monthPct * 100).toFixed(1)}%
                    </span>
                  </text>
                  <text fg="gray">{fmtCredits(m().used) + " / " + fmtCredits(m().total)}</text>
                  <text>
                    <span>今日 </span>
                    <span
                      fg={hitColor(
                        m().todayBudget ? m().todayUsed / m().todayBudget : 0,
                        "green",
                        "yellow",
                        "red",
                      )}
                    >
                      [{progressBar(m().todayBudget ? m().todayUsed / m().todayBudget : 0, 10)}]
                      {" " +
                        (m().todayBudget ? ((m().todayUsed / m().todayBudget) * 100).toFixed(0) : "0") +
                        "%"}
                      {m().todayNote}
                    </span>
                  </text>
                  <text>
                    <span>{m().winHours}h窗 </span>
                    <span
                      fg={hitColor(m().winBudget ? m().winUsed / m().winBudget : 0, "green", "yellow", "red")}
                    >
                      [{progressBar(m().winBudget ? m().winUsed / m().winBudget : 0, 9)}]
                      {" " + (m().winBudget ? ((m().winUsed / m().winBudget) * 100).toFixed(0) : "0")}%
                    </span>
                  </text>
                  <Show when={m().staleSec > 900}>
                    <text fg="yellow">
                      ⚠ 采样已停 {Math.round(m().staleSec / 60)} 分钟，今日/窗口为外推值
                    </text>
                  </Show>
                  <Show
                    when={m().verdict === "ok"}
                    fallback={
                      <text fg="red">⏸ 建议停到 {m().resumeLocal}</text>
                    }
                  >
                    <text fg="green">✅ 可继续</text>
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

// ── slash commands ──

function registerCommands(api: TuiPluginApi): void {
  api.command?.register(() => [
    {
      title: "Budget: 查看预算面板",
      value: "budget.show",
      description: "显示今日预算与 5h 窗口判断",
      category: "Budget",
      slash: { name: "budget" },
      onSelect: async (dialog) => {
        const cfg = readConfigFile()
        const wh = Number(cfg.window_hours || 5) || 5
        const r = await fetchPlan(api)
        if (r.plan) {
          appendSampleToState(r.plan.used)
          const m = compute(r.plan, wh)
          const verdict =
            m.verdict === "ok"
              ? "✅ 低于窗口预算，可继续"
              : `⏸️ 已超 ${m.winHours}h 窗口预算，建议停到 ${m.resumeLocal}（窗口滑动恢复）`
          const text = [
            `本月 ${fmtCredits(m.used)} / ${fmtCredits(m.total)} (${(m.monthPct * 100).toFixed(1)}%)`,
            `今日 ${fmtCredits(m.todayUsed)} / ${fmtCredits(m.todayBudget)} (日预算)`,
            `${m.winHours}h窗 ${fmtCredits(m.winUsed)} / ${fmtCredits(m.winBudget)} (窗口预算)`,
            verdict,
            "仅 Token Plan 模型消耗额度；免费/按量模型不计入，不会误触发",
          ].join("\n")
          dialog?.replace(() => (
            <api.ui.DialogPrompt
              title="MiMo 预算"
              placeholder={text}
              value=""
              onConfirm={() => dialog?.clear()}
              onCancel={() => dialog?.clear()}
            />
          ))
        } else {
          api.ui.toast({ variant: "error", message: r.error || "获取失败" })
          dialog?.clear()
        }
      },
    },
    {
      title: "Budget: 设置 tp- API Key",
      value: "budget.key",
      description: "设置 Token Plan 专属 API Key（tp- 开头）",
      category: "Budget",
      slash: { name: "budget-key" },
      onSelect: (dialog) => {
        dialog?.replace(() => (
          <api.ui.DialogPrompt
            title="设置 Token Plan API Key"
            placeholder="tp-xxxx..."
            onConfirm={(v: string) => {
              api.kv.set("mimo-usage-budget.tpKey", v.trim())
              api.ui.toast({ variant: "success", message: "Key 已保存" })
              dialog?.clear()
            }}
            onCancel={() => dialog?.clear()}
          />
        ))
      },
    },
    {
      title: "Budget: 设置窗口小时数",
      value: "budget.window",
      description: "设置滚动窗口长度（默认 5 小时）",
      category: "Budget",
      slash: { name: "budget-window" },
      onSelect: (dialog) => {
        dialog?.replace(() => (
          <api.ui.DialogPrompt
            title="窗口小时数"
            placeholder="5"
            onConfirm={(v: string) => {
              const n = Number(v)
              if (n > 0) api.kv.set("mimo-usage-budget.windowHours", n)
              api.ui.toast({ variant: "success", message: `窗口=${n || 5}h` })
              dialog?.clear()
            }}
            onCancel={() => dialog?.clear()}
          />
        ))
      },
    },
  ])
}

// ── entry ──

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  fsAvailable()
  api.slots.register({
    order: 56,
    slots: {
      sidebar_content(ctx: TuiSlotContext, input: { session_id: string }): JSX.Element {
        return <BudgetPanel theme={ctx.theme.current} api={api} sessionId={input.session_id} />
      },
    },
  } as TuiSlotPlugin)
  registerCommands(api)
}

const mod: TuiPluginModule & { id: string } = {
  id: "mimo-usage-budget",
  tui,
}

export default mod
