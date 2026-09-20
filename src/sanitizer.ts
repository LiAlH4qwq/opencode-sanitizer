import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

type Rule = {
  name?: string
  pattern: string
  flags?: string
  literal?: boolean
}

type SanitizeConfig = {
  rules?: Rule[]
}

type CompiledRule = {
  name: string
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
const TOKEN_PREFIX = "<opencode-sanitize:"
const TOKEN_SUFFIX = ">"
const TOKEN_RE = new RegExp(
  `${escapeRegExp(TOKEN_PREFIX)}([0-9a-f]{${TOKEN_HASH_LEN}})${escapeRegExp(TOKEN_SUFFIX)}`,
  "g",
)

function appConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(base, APP_NAME)
}

/**
 * Config sources. There is no precedence between them: the working-directory
 * `opencode-sanitizer.json` and the XDG config are both loaded and their rules
 * are applied together. The payload defaults to empty when neither exists.
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

  function tokenFor(match: string): string {
    const existing = textToToken.get(match)
    if (existing !== undefined) return existing
    const hash = createHash("sha256")
      .update(match)
      .digest("hex")
      .slice(0, TOKEN_HASH_LEN)
    const token = `${TOKEN_PREFIX}${hash}${TOKEN_SUFFIX}`
    textToToken.set(match, token)
    if (!tokenToText.has(hash)) tokenToText.set(hash, match)
    return token
  }

  function compile(rules: Rule[]): void {
    const out: CompiledRule[] = []
    for (const rule of rules) {
      if (!rule || typeof rule.pattern !== "string") continue
      const name = rule.name ?? rule.pattern
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

    const rules: Rule[] = []
    const loaded: string[] = []
    for (const path of present) {
      try {
        const config = JSON.parse(readFileSync(path, "utf8")) as SanitizeConfig
        if (Array.isArray(config.rules)) rules.push(...config.rules)
        loaded.push(path)
      } catch (error) {
        void log("warn", "sanitizer: failed to load config", {
          path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    compile(rules)
    void log("debug", `sanitizer: loaded ${compiled.length} rule(s)`, {
      paths: loaded,
    })
  }

  function sanitizeText(text: string): string {
    if (compiled.length === 0 || typeof text !== "string") return text
    let result = text
    for (const rule of compiled) {
      result = result.replace(rule.regex, (match: string) =>
        match.length === 0 ? match : tokenFor(match),
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
