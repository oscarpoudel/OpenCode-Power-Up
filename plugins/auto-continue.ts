/**
 * opencode-auto-continue (OpenCode V2 native port)
 *
 * V2 port of https://github.com/developing-today/opencode-auto-continue, which is
 * V1-only and cannot load on OpenCode V2 ("V1 plugin implementations do not run
 * in V2"). Behaviour is preserved; the API surface changed:
 *
 *   V1 event                    -> V2 event
 *   -------------------------      -------------------------
 *   session.error                  session.execution.failed
 *   message.updated (done, no err)  session.execution.succeeded
 *   session.idle                   session.idle            (unchanged)
 *
 *   V1 error { name, message }  ->  V2 error { type, message }
 *   V1 event.properties         ->  V2 event.data
 *
 * Sends "continue" when a session goes idle after a retryable error.
 * Config: <project>/.opencode/opencode-auto-continue.jsonc (all keys optional).
 */

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"

const CONFIG_FILE = "opencode-auto-continue.jsonc"
const CONTINUE_TEXT = "continue"

const DEFAULT_ERROR_PATTERNS = [
  // API / provider errors
  "bad request",
  "reasoning_opaque",
  "prefill",
  "SSE read timed out",
  "DecimalError",
  // Context / compaction errors
  "ContextOverflowError",
  "too large to compact",
  // Tool execution errors
  "Invalid diff",
  "Tool execution aborted",
  "JSON parsing failed",
  "Invalid input for tool",
  "tried to call unavailable tool",
  "finding less tool calls",
  "tool_use ids were found without tool_result",
  // Connection errors (mid-stream, not initial connect)
  "ECONNREFUSED",
  "ECONNRESET",
  // Stream / timeout errors
  "idle timeout",
  "no data received",
  // Type / validation errors
  "expected string, received undefined",
]

const DEFAULT_EXCLUDE_PATTERNS = [
  // User-initiated abort - never auto-continue
  "MessageAbortedError",
  "operation was aborted",
]

const DEFAULTS = {
  enabled: true,
  throttleMs: 5_000,
  delayMs: 500,
  maxConsecutive: 5,
  errorPatterns: DEFAULT_ERROR_PATTERNS,
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
}

type Config = typeof DEFAULTS

interface SessionState {
  pending: boolean
  lastContinueAt: number
  consecutive: number
}

/** V2 SessionError.Error shape (see @opencode/schema/session-error). */
interface V2Error {
  type?: string
  message?: string
  status?: number
  response?: { body?: string }
}

/** Minimal JSONC: strip // and /* *\/ comments, then trailing commas. */
function parseJsonc(raw: string): unknown {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const next = raw[i + 1]
    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i++
      } else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      inLine = true
      i++
      continue
    }
    if (c === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"))
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

async function loadConfig(directory: string): Promise<Config> {
  const config: Config = { ...DEFAULTS, errorPatterns: [...DEFAULT_ERROR_PATTERNS], excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS] }
  try {
    const parsed = parseJsonc(await readFile(join(directory, ".opencode", CONFIG_FILE), "utf-8")) as Record<string, unknown>
    if (typeof parsed.enabled === "boolean") config.enabled = parsed.enabled
    const throttle = num(parsed.throttleMs)
    const delay = num(parsed.delayMs)
    const max = num(parsed.maxConsecutive)
    if (throttle !== undefined) config.throttleMs = throttle
    if (delay !== undefined) config.delayMs = delay
    if (max !== undefined) config.maxConsecutive = max
    if (Array.isArray(parsed.errorPatterns)) config.errorPatterns = parsed.errorPatterns.filter((p): p is string => typeof p === "string")
    if (Array.isArray(parsed.excludePatterns)) config.excludePatterns = parsed.excludePatterns.filter((p): p is string => typeof p === "string")
  } catch {
    // No config file, or unreadable/invalid -> defaults.
  }
  return config
}

/** Build the lowercase haystack. V2 exposes error.type, not error.name. */
function haystack(error: V2Error): string {
  const type = typeof error.type === "string" ? error.type : ""
  const message = typeof error.message === "string" ? error.message : ""
  const body = typeof error.response?.body === "string" ? error.response.body : ""
  return `${type}: ${message} ${body}`.toLowerCase()
}

function isRetryable(error: V2Error | undefined, config: Config): boolean {
  if (!error) return false
  const hay = haystack(error)
  if (!hay.trim()) return false
  // Excludes are checked first so a user abort is never retried.
  if (config.excludePatterns.some((p) => hay.includes(p.toLowerCase()))) return false
  return config.errorPatterns.some((p) => hay.includes(p.toLowerCase()))
}

function describe(config: Config, overrides?: Partial<Config>): string {
  const c = overrides ? { ...config, ...overrides } : config
  const max = c.maxConsecutive > 0 ? String(c.maxConsecutive) : "unlimited"
  return `enabled=${c.enabled} throttle=${c.throttleMs}ms delay=${c.delayMs}ms max=${max}`
}

/**
 * The plugins directory is both auto-discovered and listed explicitly in
 * opencode.json, so this module can be evaluated twice. Keep one live instance.
 */
const GUARD = Symbol.for("opencode.auto-continue.v2.active")

export default Plugin.define({
  id: "opencode-auto-continue",
  setup(ctx) {
    const g = globalThis as Record<symbol, { config: Config; overrides: Map<string, Partial<Config>>; states: Map<string, SessionState>; timers: Map<string, ReturnType<typeof setTimeout>> } | undefined>

    if (g[GUARD]) {
      // Already active for this process; do not register a second listener.
      return () => {}
    }

    const config: Config = { ...DEFAULTS, errorPatterns: [...DEFAULT_ERROR_PATTERNS], excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS] }
    const overrides = new Map<string, Partial<Config>>()
    const states = new Map<string, SessionState>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    g[GUARD] = { config, overrides, states, timers }

    const configPath = join(ctx.location.directory, ".opencode", CONFIG_FILE)
    void loadConfig(ctx.location.directory).then((loaded) => Object.assign(config, loaded))

    const effective = (sessionID: string): Config => {
      const o = overrides.get(sessionID)
      return o ? { ...config, ...o } : config
    }

    const stateFor = (sessionID: string): SessionState => {
      let s = states.get(sessionID)
      if (!s) {
        s = { pending: false, lastContinueAt: 0, consecutive: 0 }
        states.set(sessionID, s)
      }
      return s
    }

    async function sendContinue(sessionID: string): Promise<void> {
      const state = states.get(sessionID)
      if (!state?.pending) return

      const cfg = effective(sessionID)
      if (!cfg.enabled) return

      const now = Date.now()
      if (now - state.lastContinueAt < cfg.throttleMs) return
      if (cfg.maxConsecutive > 0 && state.consecutive >= cfg.maxConsecutive) {
        state.pending = false
        return
      }

      state.lastContinueAt = now
      state.consecutive += 1
      state.pending = false

      try {
        // prompt() returns the admitted inbox item, so this does not block on
        // the model response (the V2 equivalent of V1 promptAsync).
        await ctx.session.prompt({ sessionID, text: CONTINUE_TEXT })
      } catch {
        // Session may have been removed/interrupted; nothing to do.
      }
    }

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event.data as Record<string, unknown> | undefined
        if (!data) continue

        if (event.type === "session.execution.failed") {
          const sessionID = data.sessionID as string | undefined
          if (!sessionID) continue
          if (!config.enabled) continue
          if (isRetryable(data.error as V2Error, effective(sessionID))) {
            stateFor(sessionID).pending = true
          }
          continue
        }

        if (event.type === "session.execution.succeeded") {
          const sessionID = data.sessionID as string | undefined
          if (!sessionID) continue
          const state = states.get(sessionID)
          // A completed run clears the consecutive-retry budget.
          if (state) state.consecutive = 0
          continue
        }

        if (event.type === "session.idle") {
          const sessionID = data.sessionID as string | undefined
          if (!sessionID) continue
          const state = states.get(sessionID)
          if (!state?.pending) continue
          const cfg = effective(sessionID)
          if (!cfg.enabled) continue
          // Collapse duplicate idle events for the same pending continue.
          const existing = timers.get(sessionID)
          if (existing) clearTimeout(existing)
          timers.set(
            sessionID,
            setTimeout(() => {
              timers.delete(sessionID)
              void sendContinue(sessionID)
            }, cfg.delayMs),
          )
        }
      }
    })()

    void ctx.command.transform((editor) => {
      editor.add({
        name: "ac",
        description: "auto-continue status/on/off/reset (alias: auto-continue)",
        execute: async ({ sessionID, prompt }) => {
          const arg = prompt.text.trim().split(/\s+/).slice(1).join(" ").trim()
          const [cmd, value] = arg.split(/\s+/)
          const reply = (text: string) => ctx.session.synthetic({ sessionID, text })

          const persist = async () => {
            const payload: Record<string, unknown> = {
              enabled: config.enabled,
              throttleMs: config.throttleMs,
              delayMs: config.delayMs,
              maxConsecutive: config.maxConsecutive,
            }
            if (config.errorPatterns.join("\u0000") !== DEFAULT_ERROR_PATTERNS.join("\u0000")) payload.errorPatterns = config.errorPatterns
            if (config.excludePatterns.join("\u0000") !== DEFAULT_EXCLUDE_PATTERNS.join("\u0000")) payload.excludePatterns = config.excludePatterns
            try {
              await writeFile(configPath, JSON.stringify(payload, null, 2) + "\n", "utf-8")
            } catch {
              await reply(`auto-continue: could not write ${configPath}`)
            }
          }

          const sessionOverrides = overrides.get(sessionID) ?? {}

          switch (cmd) {
            case undefined:
            case "status":
              await reply(`auto-continue v2: ${describe(effective(sessionID))}\nglobal: ${describe(config)}\nsession: ${Object.keys(sessionOverrides).length ? JSON.stringify(sessionOverrides) : "none"}\npatterns: ${config.errorPatterns.length} match / ${config.excludePatterns.length} exclude\nconfig: ${configPath}`)
              return
            case "on":
              config.enabled = true
              sessionOverrides.enabled = true
              overrides.set(sessionID, sessionOverrides)
              await persist()
              await reply(`auto-continue enabled (${describe(effective(sessionID))})`)
              return
            case "off":
              config.enabled = false
              sessionOverrides.enabled = false
              overrides.set(sessionID, sessionOverrides)
              states.delete(sessionID)
              await reply("auto-continue disabled")
              return
            case "reset": {
              overrides.delete(sessionID)
              states.delete(sessionID)
              const loaded = await loadConfig(ctx.location.directory)
              Object.assign(config, loaded)
              await reply(`auto-continue reset to config (${describe(effective(sessionID))})`)
              return
            }
            default:
              await reply("usage: /ac [status|on|off|reset]")
          }
        },
      })
    })

    return () => {
      controller.abort()
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      delete g[GUARD]
    }
  },
})