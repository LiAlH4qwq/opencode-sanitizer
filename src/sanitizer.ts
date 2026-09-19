import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

type Rule = {
  name?: string
  pattern: string
  flags?: string
  replacement?: string
  literal?: boolean
}

type SanitizeConfig = {
  rules?: Rule[]
}

type CompiledRule = {
  name: string
  regex: RegExp
  replacement: string
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
type Logger = (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>

const APP_NAME = "opencode-sanitizer"
const APP_CONFIG_FILE = "config.json"
const PROJECT_CONFIG_FILE = "opencode-sanitizer.json"

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

  function compile(rules: Rule[]): void {
    const out: CompiledRule[] = []
    for (const rule of rules) {
      if (!rule || typeof rule.pattern !== "string") continue
      const name = rule.name ?? rule.pattern
      const replacement = typeof rule.replacement === "string" ? rule.replacement : ""
      try {
        if (rule.literal) {
          out.push({ name, regex: new RegExp(escapeRegExp(rule.pattern), "g"), replacement })
          continue
        }
        const flags = rule.flags && rule.flags.includes("g") ? rule.flags : `${rule.flags ?? ""}g`
        out.push({ name, regex: new RegExp(rule.pattern, flags), replacement })
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
    void log("debug", `sanitizer: loaded ${compiled.length} rule(s)`, { paths: loaded })
  }

  function sanitizeText(text: string): string {
    if (compiled.length === 0 || typeof text !== "string") return text
    let result = text
    for (const rule of compiled) {
      result = result.replace(rule.regex, rule.replacement)
    }
    return result
  }

  function sanitizeInPlace(value: unknown, depth = 0): void {
    if (depth > 16 || !value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item = value[index]
        if (typeof item === "string") value[index] = sanitizeText(item)
        else sanitizeInPlace(item, depth + 1)
      }
      return
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const item = record[key]
      if (typeof item === "string") record[key] = sanitizeText(item)
      else sanitizeInPlace(item, depth + 1)
    }
  }

  function sanitizePart(part: AnyPart): void {
    switch (part.type) {
      case "text":
      case "reasoning":
        if (typeof part.text === "string") part.text = sanitizeText(part.text)
        break
      case "subtask":
        if (typeof part.prompt === "string") part.prompt = sanitizeText(part.prompt)
        if (typeof part.description === "string") part.description = sanitizeText(part.description)
        break
      case "tool": {
        const state = part.state
        if (state) {
          if (typeof state.output === "string") state.output = sanitizeText(state.output)
          if (typeof state.error === "string") state.error = sanitizeText(state.error)
          if (typeof state.title === "string") state.title = sanitizeText(state.title)
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

  return { reload, sanitizeText, sanitizeInPlace, sanitizePart }
}

function createLogger(client: PluginInput["client"]): Logger {
  return async (level, message, extra) => {
    try {
      await client.app.log({ body: { service: "sanitizer", level, message, extra } })
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
  }
}

export default SanitizerPlugin
