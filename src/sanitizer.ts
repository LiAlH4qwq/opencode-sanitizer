import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

type Rule = {
  pattern: string
  flags?: string
  literal?: boolean
  placeholderHint?: string
}

type SanitizeConfig = {
  defaultPlaceholderHint?: string
  rules?: Record<string, Rule>
}

type CompiledRule = {
  name: string
  hint: string
  regex: RegExp
}

type AnyPart = {
  type: string
  text?: string
  prompt?: string
  description?: string
  source?: { text?: { value?: string } }
  state?: {
    output?: string
    error?: string
    title?: string
    input?: unknown
    metadata?: unknown
  }
  metadata?: unknown
  [key: string]: unknown
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

const TOKEN_HASH_LEN = 16
const DEFAULT_PLACEHOLDER_HINT = "6f1a3c8e-2b47-4d90-a15f-9c3e7b0d8214"
const INVALID_HINT_RE = /[<>:]/
const TOKEN_RE = new RegExp(`<[^<>:]+:([0-9a-f]{${TOKEN_HASH_LEN}})>`, "g")

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

function appConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(base, APP_NAME)
}

/**
 * Config sources, highest precedence first. Both are loaded and their rules
 * merged by name; when the same name appears in both, or both set
 * `defaultPlaceholderHint`, the working-directory `opencode-sanitizer.json`
 * wins over the XDG config. The payload defaults to empty when neither exists.
 */
function configPaths(directory: string): string[] {
  return [
    resolve(directory, PROJECT_CONFIG_FILE),
    join(appConfigDir(), APP_CONFIG_FILE),
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

  function resolveHint(hint: string | undefined, fallback: string): string {
    if (typeof hint !== "string" || hint.length === 0) return fallback
    if (INVALID_HINT_RE.test(hint)) return fallback
    return hint
  }

  function tokenFor(match: string, hint: string): string {
    const key = `${hint}\u0000${match}`
    const existing = textToToken.get(key)
    if (existing !== undefined) return existing
    const hash = createHash("sha256")
      .update(match)
      .digest("hex")
      .slice(0, TOKEN_HASH_LEN)
    const token = `<${hint}:${hash}>`
    textToToken.set(key, token)
    if (!tokenToText.has(hash)) tokenToText.set(hash, match)
    return token
  }

  function compile(rules: Record<string, Rule>, defaultHint: string): void {
    const out: CompiledRule[] = []
    for (const [name, rule] of Object.entries(rules)) {
      if (!rule || typeof rule.pattern !== "string") continue
      const hint = resolveHint(rule.placeholderHint, defaultHint)
      try {
        if (rule.literal) {
          out.push({
            name,
            hint,
            regex: new RegExp(escapeRegExp(rule.pattern), "g"),
          })
          continue
        }
        const flags = rule.flags?.includes("g")
          ? rule.flags
          : `${rule.flags ?? ""}g`
        out.push({ name, hint, regex: new RegExp(rule.pattern, flags) })
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

    const rules: Record<string, Rule> = {}
    let defaultHint: string | undefined
    const loaded: string[] = []
    for (const path of present) {
      try {
        const config = JSON.parse(readFileSync(path, "utf8")) as SanitizeConfig
        if (
          defaultHint === undefined &&
          typeof config.defaultPlaceholderHint === "string" &&
          config.defaultPlaceholderHint.length > 0
        ) {
          defaultHint = config.defaultPlaceholderHint
        }
        if (config.rules && typeof config.rules === "object") {
          for (const [name, rule] of Object.entries(config.rules)) {
            if (!(name in rules)) rules[name] = rule
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

    compile(rules, resolveHint(defaultHint, DEFAULT_PLACEHOLDER_HINT))
    void log("debug", `sanitizer: loaded ${compiled.length} rule(s)`, {
      paths: loaded,
    })
  }

  function sanitizeText(text: string): string {
    if (compiled.length === 0 || typeof text !== "string") return text
    let result = text
    for (const rule of compiled) {
      result = result.replace(rule.regex, (match: string) =>
        match.length === 0 ? match : tokenFor(match, rule.hint),
      )
    }
    return result
  }

  function restoreText(text: string): string {
    if (typeof text !== "string") return text
    return text.replace(
      TOKEN_RE,
      (whole: string, hash: string) => tokenToText.get(hash) ?? whole,
    )
  }

  function mapInPlace(
    value: unknown,
    fn: (text: string) => string,
    depth = 0,
  ): void {
    if (depth > 16 || !value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item = value[index]
        if (typeof item === "string") value[index] = fn(item)
        else mapInPlace(item, fn, depth + 1)
      }
      return
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (typeof item === "string") record[key] = fn(item)
      else mapInPlace(item, fn, depth + 1)
    }
  }

  function sanitizeInPlace(value: unknown, depth = 0): void {
    mapInPlace(value, sanitizeText, depth)
  }

  function restoreInPlace(value: unknown, depth = 0): void {
    mapInPlace(value, restoreText, depth)
  }

  function sanitizePart(part: AnyPart): void {
    switch (part.type) {
      case "text":
      case "reasoning":
        if (typeof part.text === "string") part.text = sanitizeText(part.text)
        break
      case "subtask":
        if (typeof part.prompt === "string")
          part.prompt = sanitizeText(part.prompt)
        if (typeof part.description === "string")
          part.description = sanitizeText(part.description)
        break
      case "tool": {
        const state = part.state
        if (state) {
          if (typeof state.output === "string")
            state.output = sanitizeText(state.output)
          if (typeof state.error === "string")
            state.error = sanitizeText(state.error)
          if (typeof state.title === "string")
            state.title = sanitizeText(state.title)
          sanitizeInPlace(state.input)
          sanitizeInPlace(state.metadata)
        }
        sanitizeInPlace(part.metadata)
        break
      }
      case "file": {
        const sourceText = part.source?.text
        if (sourceText && typeof sourceText.value === "string") {
          sourceText.value = sanitizeText(sourceText.value)
        }
        break
      }
      default:
        break
    }
  }

  return {
    reload,
    hasRules: () => compiled.length > 0,
    sanitizeText,
    sanitizeInPlace,
    sanitizePart,
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
        for (const part of message.parts as unknown as AnyPart[]) {
          sanitizer.sanitizePart(part)
        }
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      sanitizer.reload()
      for (let index = 0; index < output.system.length; index++) {
        output.system[index] = sanitizer.sanitizeText(output.system[index])
      }
      if (sanitizer.hasRules()) output.system.push(SYSTEM_NOTICE)
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
