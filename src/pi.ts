import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ContextEventResult,
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  SessionBeforeCompactEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent"
import {
  configPaths,
  createSanitizer,
  FREE_FORM_KEYS,
  type Logger,
  STRUCTURAL_KEYS,
  SYSTEM_NOTICE,
} from "./engine.ts"

/**
 * Pi protocol fields that must survive sanitizing untouched. Anything that
 * routes, identifies, selects, or configures a tool must never be rewritten:
 * replacing a tool name, a provider, a stop reason, or a JSON schema would
 * break the request instead of hiding content.
 */
const PI_STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  ...STRUCTURAL_KEYS,
  // Identity of the tool call and its target.
  "toolCallId",
  "toolName",
  "name",
  "namespace",
  // Assistant/provider metadata.
  "api",
  "provider",
  "model",
  "responseModel",
  "responseId",
  "providerThinkingLevel",
  "stopReason",
  "rawStopReason",
  "thinkingSignature",
  "textSignature",
  "thoughtSignature",
  "redacted",
  // Non-text payloads and bookkeeping.
  "mimeType",
  "timestamp",
  "exitCode",
  "cancelled",
  "truncated",
  "isError",
  "display",
  "customType",
  "fromId",
  "tokensBefore",
])

/**
 * Pi keys whose values are structured payloads that must be copied verbatim.
 * The subtree is never traversed: rewriting a JSON-schema `pattern`, `enum`, or
 * `$ref`, or base64 image data, would break the request rather than hide text.
 */
const PI_OPAQUE_KEYS: ReadonlySet<string> = new Set([
  "parameters",
  "constrainedSampling",
  "inputSchema",
  "outputSchema",
  "schema",
  "data",
  "usage",
  "cost",
  "deferred",
])

/**
 * Pi keys that hold arbitrary user or tool data. Inside them the structural
 * exemption is dropped, so a key such as `name` nested in tool arguments is
 * still sanitized.
 */
const PI_FREE_FORM_KEYS: ReadonlySet<string> = new Set([
  ...FREE_FORM_KEYS,
  "arguments",
  "details",
])

const DEBUG =
  process.env.SANITIZER_DEBUG === "1" ||
  process.env.OPENCODE_SANITIZER_DEBUG === "1"

const log: Logger = async (level, message, extra) => {
  if (level === "debug" || level === "info") {
    if (!DEBUG) return
  }
  const detail = extra ? ` ${JSON.stringify(extra)}` : ""
  console.error(`[opencode-sanitizer] ${message}${detail}`)
}

/**
 * Pi extension: reversibly pseudonymize configured strings in every model
 * request and restore them in tool arguments and persisted messages, mirroring
 * the opencode plugin.
 *
 * Request transforms (`context`, `before_agent_start`, `session_before_compact`)
 * only affect the outgoing model call; the session file keeps its originals.
 * Restores (`message_end`, `tool_call`) put the real values back before a
 * message is stored or a tool runs.
 */
export default function sanitizerExtension(pi: ExtensionAPI): void {
  let cwd = process.cwd()
  const sanitizer = createSanitizer(() => configPaths(cwd), log)

  function sync(ctx: ExtensionContext): void {
    cwd = ctx.cwd
    sanitizer.reload()
  }

  pi.on(
    "before_agent_start",
    (
      event: BeforeAgentStartEvent,
      ctx,
    ): BeforeAgentStartEventResult | undefined => {
      sync(ctx)
      if (!sanitizer.hasRules()) return undefined
      const base = sanitizer.sanitizeText(event.systemPrompt)
      return {
        systemPrompt: base ? `${base}\n\n${SYSTEM_NOTICE}` : SYSTEM_NOTICE,
      }
    },
  )

  pi.on(
    "context",
    (event: ContextEvent, ctx): ContextEventResult | undefined => {
      sync(ctx)
      if (!sanitizer.hasRules()) return undefined
      for (const message of event.messages) {
        sanitizer.sanitizeDeep(
          message,
          undefined,
          PI_STRUCTURAL_KEYS,
          PI_FREE_FORM_KEYS,
          PI_OPAQUE_KEYS,
        )
      }
      return { messages: event.messages }
    },
  )

  // The full transcript, including the leading system message that carries the
  // prompt and tool declarations. Only system messages are touched here: the
  // `context` handler already cleaned the conversation, and this closes the one
  // gap it cannot reach, tool descriptions. Pi's forced-prompt projection then
  // collapses these messages into the head the provider receives.
  pi.on(
    "context_with_system",
    (event: ContextWithSystemEvent, ctx): ContextEventResult | undefined => {
      sync(ctx)
      if (!sanitizer.hasRules()) return undefined
      let changed = false
      for (const message of event.messages) {
        if ((message as { role?: unknown }).role !== "system") continue
        sanitizer.sanitizeDeep(
          message,
          undefined,
          PI_STRUCTURAL_KEYS,
          PI_FREE_FORM_KEYS,
          PI_OPAQUE_KEYS,
        )
        changed = true
      }
      return changed ? { messages: event.messages } : undefined
    },
  )

  pi.on(
    "session_before_compact",
    (event: SessionBeforeCompactEvent, ctx): void => {
      sync(ctx)
      if (!sanitizer.hasRules()) return
      const { preparation } = event
      for (const message of preparation.messagesToSummarize) {
        sanitizer.sanitizeDeep(
          message,
          undefined,
          PI_STRUCTURAL_KEYS,
          PI_FREE_FORM_KEYS,
          PI_OPAQUE_KEYS,
        )
      }
      for (const message of preparation.turnPrefixMessages) {
        sanitizer.sanitizeDeep(
          message,
          undefined,
          PI_STRUCTURAL_KEYS,
          PI_FREE_FORM_KEYS,
          PI_OPAQUE_KEYS,
        )
      }
      if (typeof preparation.previousSummary === "string") {
        preparation.previousSummary = sanitizer.sanitizeText(
          preparation.previousSummary,
        )
      }
    },
  )

  pi.on(
    "message_end",
    (event: MessageEndEvent): MessageEndEventResult | undefined => {
      if (!sanitizer.restoreInPlace(event.message)) return undefined
      return { message: event.message }
    },
  )

  pi.on("tool_call", (event: ToolCallEvent) => {
    sanitizer.restoreInPlace(event.input)
  })
}

export { PI_FREE_FORM_KEYS, PI_OPAQUE_KEYS, PI_STRUCTURAL_KEYS }
