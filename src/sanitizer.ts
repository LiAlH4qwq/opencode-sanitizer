import { randomBytes } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

type Rule = {
  pattern: string
  flags?: string
  literal?: boolean
}

type SanitizeConfig = {
  rules?: Record<string, Rule>
}

type CompiledRule = {
  name: string
  regex: RegExp
}

type NamedRule = {
  name: string
  rule: Rule
}

type Candidate = {
  start: number
  end: number
}

type LogLevel = "debug" | "info" | "warn" | "error"
type Logger = (
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

const APP_NAME = "opencode-sanitizer"
const APP_CONFIG_FILE = "config.json"
const PROJECT_CONFIG_FILE = "opencode-sanitizer.json"

const TOKEN_ID_LEN = 16
const TOKEN_HINT = "6f1a3c8e-2b47-4d90-a15f-9c3e7b0d8214"
const TOKEN_RE = new RegExp(
  `<[^<>:\\s]+\\s*:\\s*([0-9a-f]{${TOKEN_ID_LEN}})\\s*>`,
  "gi",
)

const SYSTEM_NOTICE = [
  "Redaction notice: a token shaped like `<HINT:HASH>` -- angle brackets around",
  "a label, a colon, then 16 lowercase hex characters -- is an opaque,",
  "irreversible placeholder that replaced sensitive text before it reached you.",
  "It carries no recoverable meaning. Never attempt to decode, guess,",
  "reconstruct, restore, translate, explain, or speculate about what it",
  "replaced, and never emit the original text even if you believe you can infer",
  "it. Treat such tokens as meaningless constant identifiers and reproduce them",
  "verbatim, exactly as given, wherever they appear.",
].join(" ")

/**
 * Keys whose string values are protocol identifiers, enums or routing names.
 * They are never rewritten: tokenizing them would break the request (ids,
 * `type`, `role`, `tool`, `agent`, ...) rather than hide content.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "sessionID",
  "messageID",
  "parentID",
  "partID",
  "callID",
  "projectID",
  "providerID",
  "modelID",
  "type",
  "role",
  "mode",
  "status",
  "tool",
  "agent",
  "finish",
  "reason",
  "mime",
  "url",
])

/**
 * Keys that contain arbitrary user/tool data. Inside them the structural
 * exemption is dropped, so a key such as `url` or `type` nested in tool input
 * is still sanitized.
 */
const FREE_FORM_KEYS: ReadonlySet<string> = new Set([
  "input",
  "metadata",
  "summary",
  "error",
  "source",
])

const NO_SKIP: ReadonlySet<string> = new Set()

function appConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(base, APP_NAME)
}

/**
 * Config sources: the XDG (global) config and the working-directory
 * `opencode-sanitizer.json`. Both are loaded and their rules combined; rule
 * names are only labels for logs. Every match from every rule is redacted, and
 * overlapping matches merge into a single token, so file order and rule names
 * never change the result. The payload defaults to empty when neither exists.
 */
function configPaths(directory: string): string[] {
  return [
    join(appConfigDir(), APP_CONFIG_FILE),
    resolve(directory, PROJECT_CONFIG_FILE),
  ]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function createSanitizer(getPaths: () => string[], log: Logger) {
  let compiled: CompiledRule[] = []
  let lastSignature = ""

  const tokenToText = new Map<string, string>()
  const textToToken = new Map<string, string>()

  function tokenFor(match: string): string {
    const existing = textToToken.get(match)
    if (existing !== undefined) return existing
    let id = randomBytes(TOKEN_ID_LEN / 2).toString("hex")
    while (tokenToText.has(id)) {
      id = randomBytes(TOKEN_ID_LEN / 2).toString("hex")
    }
    const token = `<${TOKEN_HINT}:${id}>`
    textToToken.set(match, token)
    tokenToText.set(id, match)
    return token
  }

  function compile(namedRules: NamedRule[]): void {
    const out: CompiledRule[] = []
    for (const { name, rule } of namedRules) {
      if (!rule || typeof rule.pattern !== "string") continue
      try {
        if (rule.literal) {
          out.push({
            name,
            regex: new RegExp(escapeRegExp(rule.pattern), "g"),
          })
          continue
        }
        const flags = rule.flags?.includes("g")
          ? rule.flags
          : `${rule.flags ?? ""}g`
        out.push({ name, regex: new RegExp(rule.pattern, flags) })
      } catch (error) {
        void log("warn", `sanitizer: invalid pattern for rule "${name}"`, {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    compiled = out
  }

  function reload(): void {
    const present: string[] = []
    let signature = ""
    for (const path of getPaths()) {
      try {
        const stat = statSync(path)
        signature += `${path}:${stat.mtimeMs}:${stat.size};`
        present.push(path)
      } catch {
        signature += `${path}:missing;`
      }
    }
    if (signature === lastSignature) return
    lastSignature = signature

    const namedRules: NamedRule[] = []
    const loaded: string[] = []
    for (const path of present) {
      try {
        const config = JSON.parse(readFileSync(path, "utf8")) as SanitizeConfig
        if (config.rules && typeof config.rules === "object") {
          for (const [name, rule] of Object.entries(config.rules)) {
            namedRules.push({ name, rule })
          }
        }
        loaded.push(path)
      } catch (error) {
        void log("warn", "sanitizer: failed to load config", {
          path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    compile(namedRules)
    void log("debug", `sanitizer: loaded ${compiled.length} rule(s)`, {
      paths: loaded,
    })
  }

  function collectCandidates(text: string): Candidate[] {
    const candidates: Candidate[] = []
    for (const rule of compiled) {
      for (const match of text.matchAll(rule.regex)) {
        const matched = match[0]
        if (matched.length === 0) continue
        const start = match.index ?? 0
        candidates.push({ start, end: start + matched.length })
      }
    }
    return candidates
  }

  /**
   * Sanitizes a run of text that is known to contain no existing token, so
   * matches never span or rewrite a token and the operation is idempotent.
   *
   * Every match from every rule is redacted: overlapping matches are merged
   * into a single token spanning their union, so no matched character can
   * survive, not even as a fragment of a discarded match.
   */
  function sanitizeSegment(text: string): string {
    const candidates = collectCandidates(text)
    if (candidates.length === 0) return text
    candidates.sort((a, b) => a.start - b.start || a.end - b.end)
    let result = ""
    let cursor = 0
    let index = 0
    while (index < candidates.length) {
      const start = candidates[index].start
      let end = candidates[index].end
      index++
      while (index < candidates.length && candidates[index].start < end) {
        if (candidates[index].end > end) end = candidates[index].end
        index++
      }
      result += text.slice(cursor, start)
      result += tokenFor(text.slice(start, end))
      cursor = end
    }
    return result + text.slice(cursor)
  }

  function sanitizeText(text: string): string {
    if (compiled.length === 0 || typeof text !== "string") return text
    if (!text.includes("<")) return sanitizeSegment(text)
    const result: string[] = []
    let cursor = 0
    for (const match of text.matchAll(TOKEN_RE)) {
      const id = (match[1] ?? "").toLowerCase()
      if (!tokenToText.has(id)) continue
      const start = match.index ?? 0
      if (start > cursor)
        result.push(sanitizeSegment(text.slice(cursor, start)))
      result.push(match[0])
      cursor = start + match[0].length
    }
    if (cursor < text.length) result.push(sanitizeSegment(text.slice(cursor)))
    return result.join("")
  }

  function restoreText(text: string): string {
    if (typeof text !== "string") return text
    return text.replace(
      TOKEN_RE,
      (whole: string, id: string) => tokenToText.get(id.toLowerCase()) ?? whole,
    )
  }

  function mapInPlace(
    value: unknown,
    fn: (text: string) => string,
    seen: WeakSet<object> = new WeakSet(),
  ): void {
    if (!value || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item = value[index]
        if (typeof item === "string") value[index] = fn(item)
        else mapInPlace(item, fn, seen)
      }
      return
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (typeof item === "string") record[key] = fn(item)
      else mapInPlace(item, fn, seen)
    }
  }

  function restoreInPlace(value: unknown): void {
    mapInPlace(value, restoreText)
  }

  /**
   * Sanitizes every string in a message (info and parts) by default, and only
   * skips values under {@link STRUCTURAL_KEYS}. Nesting inside a free-form key
   * drops that exemption, so tool input like `{ url: ... }` is still cleaned.
   * This is a denylist rather than a per-field allowlist, so a field that is
   * added to the SDK or forgotten by name cannot silently leak.
   */
  function sanitizeDeep(
    value: unknown,
    seen: WeakSet<object> = new WeakSet(),
    skip: ReadonlySet<string> = STRUCTURAL_KEYS,
  ): void {
    if (!value || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item = value[index]
        if (typeof item === "string") value[index] = sanitizeText(item)
        else sanitizeDeep(item, seen, skip)
      }
      return
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (typeof item === "string") {
        if (!skip.has(key)) record[key] = sanitizeText(item)
        continue
      }
      if (!item || typeof item !== "object") continue
      sanitizeDeep(item, seen, FREE_FORM_KEYS.has(key) ? NO_SKIP : skip)
    }
  }

  return {
    reload,
    hasRules: () => compiled.length > 0,
    sanitizeText,
    sanitizeDeep,
    restoreText,
    restoreInPlace,
  }
}

function createLogger(client: PluginInput["client"]): Logger {
  return async (level, message, extra) => {
    try {
      await client.app.log({
        body: { service: "sanitizer", level, message, extra },
      })
    } catch {
      return
    }
  }
}

export const SanitizerPlugin: Plugin = async (input) => {
  const log = createLogger(input.client)
  const paths = configPaths(input.directory)
  const sanitizer = createSanitizer(() => paths, log)
  sanitizer.reload()
  await log("info", "sanitizer: initialized", { paths })

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      sanitizer.reload()
      for (const message of output.messages) {
        sanitizer.sanitizeDeep(message)
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      sanitizer.reload()
      for (let index = 0; index < output.system.length; index++) {
        output.system[index] = sanitizer.sanitizeText(output.system[index])
      }
      if (sanitizer.hasRules()) output.system.push(SYSTEM_NOTICE)
    },
    "experimental.session.compacting": async (_input, output) => {
      sanitizer.reload()
      for (let index = 0; index < output.context.length; index++) {
        output.context[index] = sanitizer.sanitizeText(output.context[index])
      }
      if (typeof output.prompt === "string") {
        output.prompt = sanitizer.sanitizeText(output.prompt)
      }
    },
    "tool.definition": async (_input, output) => {
      sanitizer.reload()
      output.description = sanitizer.sanitizeText(output.description)
    },
    "experimental.text.complete": async (_input, output) => {
      output.text = sanitizer.restoreText(output.text)
    },
    "tool.execute.before": async (_input, output) => {
      sanitizer.restoreInPlace(output.args)
    },
  }
}

export default SanitizerPlugin
