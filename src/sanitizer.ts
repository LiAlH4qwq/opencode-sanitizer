import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import {
  configPaths,
  createSanitizer,
  type Logger,
  SYSTEM_NOTICE,
} from "./engine.ts"

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
