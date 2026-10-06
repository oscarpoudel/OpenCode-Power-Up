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
 * Config: <location>/.opencode/opencode-auto-continue.jsonc (all keys optional).
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

interface Config {
  enabled: boolean
  throttleMs: number
  delayMs: number
  maxConsecutive: number
  errorPatterns: string[]
  excludePatterns: string[]
}

function defaults(): Config {
  return {
    enabled: true,
    throttleMs: 5_000,
    delayMs: 500,
    maxConsecutive: 5,
    errorPatterns: [...DEFAULT_ERROR_PATTERNS],
    excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
  }
}

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

/** Minimal JSONC: strip // and block comments, then trailing commas. */
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
  const config = defaults()
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

function describe(config: Config): string {
  const max = config.maxConsecutive > 0 ? String(config.maxConsecutive) : "unlimited"
  return `enabled=${config.enabled} throttle=${config.throttleMs}ms delay=${config.delayMs}ms max=${max}`
}

/**
 * OpenCode loads this plugin once per *location* inside a single process, and the
 * event stream is server-wide. So state is split deliberately:
 *
 *  - One event subscription for the whole process. Two subscriptions would
 *    double-send "continue" for the same session.
 *  - Config is per location, resolved from event.location.directory, so two
 *    locations with different opencode-auto-continue.jsonc behave independently.
 *  - Events are ignored for directories where this plugin is not loaded, so the
 *    server-wide stream cannot trigger a continue in an unrelated project.
 *  - The /ac command is registered per location, because each location has its
 *    own command list.
 */
const SHARED = Symbol.for("opencode.auto-continue.v2")

interface Shared {
  /** Per-location config, loaded during setup. */
  configs: Map<string, Config>
  /** Directories where this plugin instance is set up. */
  dirs: Set<string>
  /** Directories that already have the command registered. */
  commandDirs: Set<string>
  /** Session-scoped runtime overrides from /ac. */
  overrides: Map<string, Partial<Config>>
  states: Map<string, SessionState>
  timers: Map<string, ReturnType<typeof setTimeout>>
  /** ctx used to send prompts; the first location to load provides it. */
  sender?: { session: { prompt: (input: { sessionID: string; text: string }) => Promise<unknown> } }
  started: boolean
}

function shared(): Shared {
  const g = globalThis as Record<symbol, Shared | undefined>
  let s = g[SHARED]
  if (!s) {
    s = {
      configs: new Map(),
      dirs: new Set(),
      commandDirs: new Set(),
      overrides: new Map(),
      states: new Map(),
      timers: new Map(),
      started: false,
    }
    g[SHARED] = s
  }
  return s
}

export default Plugin.define({
  id: "opencode-auto-continue",
  async setup(ctx) {
    const s = shared()
    const directory = ctx.location.directory

    // Resolve this location's config before any event can arrive.
    s.configs.set(directory, await loadConfig(directory))
    s.dirs.add(directory)
    if (!s.sender) s.sender = ctx as unknown as Shared["sender"]

    const configFor = (dir: string | undefined): Config | undefined => (dir ? s.configs.get(dir) : undefined)

    const effective = (sessionID: string, base: Config): Config => {
      const o = s.overrides.get(sessionID)
      return o ? { ...base, ...o } : base
    }

    const stateFor = (sessionID: string): SessionState => {
      let existing = s.states.get(sessionID)
      if (!existing) {
        existing = { pending: false, lastContinueAt: 0, consecutive: 0 }
        s.states.set(sessionID, existing)
      }
      return existing
    }

    async function sendContinue(sessionID: string, dir: string, base: Config): Promise<void> {
      const state = s.states.get(sessionID)
      if (!state?.pending) return

      const config = effective(sessionID, base)
      if (!config.enabled) return

      const now = Date.now()
      if (now - state.lastContinueAt < config.throttleMs) return
      if (config.maxConsecutive > 0 && state.consecutive >= config.maxConsecutive) {
        state.pending = false
        return
      }

      state.lastContinueAt = now
      state.consecutive += 1
      state.pending = false

      try {
        // prompt() returns the admitted inbox item, so this does not block on
        // the model response (the V2 equivalent of V1 promptAsync).
        await s.sender?.session.prompt({ sessionID, text: CONTINUE_TEXT })
      } catch {
        // Session may have been removed/interrupted; nothing to do.
      }
      void dir
    }

    if (!s.started) {
      s.started = true
      const controller = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event.data as Record<string, unknown> | undefined
          if (!data) continue

          const location = (event as { location?: { directory?: string } }).location?.directory
          // Only act on sessions in locations where this plugin is loaded.
          const base = configFor(location)
          if (!base) continue

          if (event.type === "session.execution.failed") {
            const sessionID = data.sessionID as string | undefined
            if (!sessionID) continue
            if (!effective(sessionID, base).enabled) continue
            if (isRetryable(data.error as V2Error, effective(sessionID, base))) {
              stateFor(sessionID).pending = true
            }
            continue
          }

          if (event.type === "session.execution.succeeded") {
            const sessionID = data.sessionID as string | undefined
            if (!sessionID) continue
            const state = s.states.get(sessionID)
            // A completed run clears the consecutive-retry budget.
            if (state) state.consecutive = 0
            continue
          }

          if (event.type === "session.idle") {
            const sessionID = data.sessionID as string | undefined
            if (!sessionID) continue
            const state = s.states.get(sessionID)
            if (!state?.pending) continue
            const config = effective(sessionID, base)
            if (!config.enabled) continue
            // Collapse duplicate idle events for the same pending continue.
            const existing = s.timers.get(sessionID)
            if (existing) clearTimeout(existing)
            s.timers.set(
              sessionID,
              setTimeout(() => {
                s.timers.delete(sessionID)
                void sendContinue(sessionID, location ?? "", base)
              }, config.delayMs),
            )
          }
        }
      })()
    }

    // Register /ac for this location. Each location has its own command list,
    // so de-duplicate per directory rather than process-wide.
    if (!s.commandDirs.has(directory)) {
      s.commandDirs.add(directory)
      const configPath = join(directory, ".opencode", CONFIG_FILE)

      void ctx.command.transform((editor) => {
        editor.add({
          name: "ac",
          description: "auto-continue status/on/off/reset",
          execute: async ({ sessionID, prompt }) => {
            // In V2 prompt.text holds only the text AFTER the command name, so
            // "/ac status" arrives as "status". Tolerate the command name being
            // echoed back too, so both forms parse the same.
            const tokens = prompt.text.trim() ? prompt.text.trim().split(/\s+/) : []
            const head = tokens[0]?.replace(/^\//, "")
            if (head === "ac" || head === "auto-continue") tokens.shift()
            const cmd: string | undefined = tokens[0] || undefined
            const base = configFor(directory) ?? defaults()
            const reply = (text: string) => ctx.session.synthetic({ sessionID, text })
            const sessionOverrides = s.overrides.get(sessionID) ?? {}

            const persist = async () => {
              const payload: Record<string, unknown> = {
                enabled: base.enabled,
                throttleMs: base.throttleMs,
                delayMs: base.delayMs,
                maxConsecutive: base.maxConsecutive,
              }
              if (base.errorPatterns.join(" ") !== DEFAULT_ERROR_PATTERNS.join(" ")) payload.errorPatterns = base.errorPatterns
              if (base.excludePatterns.join(" ") !== DEFAULT_EXCLUDE_PATTERNS.join(" ")) payload.excludePatterns = base.excludePatterns
              try {
                await writeFile(configPath, JSON.stringify(payload, null, 2) + "\n", "utf-8")
              } catch {
                await reply(`auto-continue: could not write ${configPath}`)
              }
            }

            switch (cmd) {
              case undefined:
              case "status":
                await reply(
                  [
                    `auto-continue v2: ${describe(effective(sessionID, base))}`,
                    `location: ${directory}`,
                    `session overrides: ${Object.keys(sessionOverrides).length ? JSON.stringify(sessionOverrides) : "none"}`,
                    `patterns: ${base.errorPatterns.length} match / ${base.excludePatterns.length} exclude`,
                    `config: ${configPath}`,
                  ].join("\n"),
                )
                return
              case "on":
                // Session-scoped only. Writing the config file needs "global on".
                sessionOverrides.enabled = true
                s.overrides.set(sessionID, sessionOverrides)
                s.states.delete(sessionID)
                await reply(`auto-continue enabled for this session (${describe(effective(sessionID, base))})`)
                return
              case "off":
                sessionOverrides.enabled = false
                s.overrides.set(sessionID, sessionOverrides)
                s.states.delete(sessionID)
                await reply("auto-continue disabled for this session (config file unchanged)")
                return
              case "global": {
                const which = tokens[1]
                if (which === "on") base.enabled = true
                else if (which === "off") base.enabled = false
                else if (which === "reset") {
                  const reloaded = await loadConfig(directory)
                  s.configs.set(directory, reloaded)
                  await reply(`auto-continue reloaded from config (${describe(configFor(directory)!)}`)
                  return
                } else {
                  await reply("usage: /ac global on|off|reset")
                  return
                }
                s.overrides.delete(sessionID)
                s.states.delete(sessionID)
                await persist()
                await reply(`auto-continue globally ${base.enabled ? "enabled" : "disabled"} (${describe(configFor(directory)!)}); wrote ${configPath}`)
                return
              }
              case "reset": {
                s.overrides.delete(sessionID)
                s.states.delete(sessionID)
                const reloaded = await loadConfig(directory)
                s.configs.set(directory, reloaded)
                await reply(`auto-continue reset to config (${describe(reloaded)})`)
                return
              }
              default:
                await reply("usage: /ac [status|on|off|reset|global on|global off|global reset]")
            }
          },
        })
      })
    }

    return () => {
      s.dirs.delete(directory)
      s.commandDirs.delete(directory)
    }
  },
})