import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import sanitizerExtension from "../src/pi.ts"

const TOKEN_SHAPE = /^<[^<>\s]+:\s*[0-9a-f]{16}>$/i
const TOKEN_ANY = /<[^<>\s]+:\s*[0-9a-f]{16}>/i

type Handler = (event: unknown, ctx: unknown) => unknown

type ScenarioOptions = {
  globalRules?: Record<string, unknown>
  projectRules?: Record<string, unknown>
  projectRaw?: string
}

type Scenario = {
  handlers: Map<string, Handler>
  ctx: { cwd: string }
  projectDir: string
  cleanup: () => void
}

async function createScenario(
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const globalRoot = mkdtempSync(join(tmpdir(), "pi-sanitizer-global-"))
  const projectDir = mkdtempSync(join(tmpdir(), "pi-sanitizer-project-"))
  const previousXdg = process.env.XDG_CONFIG_HOME

  const globalConfigDir = join(globalRoot, "opencode-sanitizer")
  mkdirSync(globalConfigDir, { recursive: true })
  if (options.globalRules !== undefined) {
    writeFileSync(
      join(globalConfigDir, "config.json"),
      JSON.stringify({ rules: options.globalRules }),
    )
  }
  if (options.projectRaw !== undefined) {
    writeFileSync(
      join(projectDir, "opencode-sanitizer.json"),
      options.projectRaw,
    )
  } else if (options.projectRules !== undefined) {
    writeFileSync(
      join(projectDir, "opencode-sanitizer.json"),
      JSON.stringify({ rules: options.projectRules }),
    )
  }

  process.env.XDG_CONFIG_HOME = globalRoot

  const handlers = new Map<string, Handler>()
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }

  sanitizerExtension(pi as unknown as Parameters<typeof sanitizerExtension>[0])

  return {
    handlers,
    ctx: { cwd: projectDir },
    projectDir,
    cleanup: () => {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
      rmSync(globalRoot, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    },
  }
}

async function withScenario<T>(
  options: ScenarioOptions,
  run: (scenario: Scenario) => Promise<T> | T,
): Promise<T> {
  const scenario = await createScenario(options)
  try {
    return await run(scenario)
  } finally {
    scenario.cleanup()
  }
}

function handler(scenario: Scenario, name: string): Handler {
  const found = scenario.handlers.get(name)
  assert.ok(found, `handler "${name}" must be registered`)
  return found
}

async function runContext(
  scenario: Scenario,
  messages: unknown[],
): Promise<unknown[]> {
  const result = (await handler(scenario, "context")(
    { type: "context", messages },
    scenario.ctx,
  )) as { messages: unknown[] } | undefined
  assert.ok(result, "context handler must return messages when rules exist")
  return result.messages
}

async function runContextMaybe(
  scenario: Scenario,
  messages: unknown[],
): Promise<unknown[] | undefined> {
  const result = (await handler(scenario, "context")(
    { type: "context", messages },
    scenario.ctx,
  )) as { messages: unknown[] } | undefined
  return result?.messages
}

async function runContextWithSystem(
  scenario: Scenario,
  messages: unknown[],
): Promise<unknown[]> {
  const result = (await handler(scenario, "context_with_system")(
    { type: "context_with_system", messages },
    scenario.ctx,
  )) as { messages: unknown[] } | undefined
  return result?.messages ?? messages
}

async function runSystemPrompt(
  scenario: Scenario,
  systemPrompt: string,
): Promise<string | undefined> {
  const result = (await handler(scenario, "before_agent_start")(
    { type: "before_agent_start", prompt: "hi", systemPrompt },
    scenario.ctx,
  )) as { systemPrompt?: string } | undefined
  return result?.systemPrompt
}

async function runMessageEnd(
  scenario: Scenario,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = (await handler(scenario, "message_end")(
    { type: "message_end", message },
    scenario.ctx,
  )) as { message?: Record<string, unknown> } | undefined
  return result?.message ?? message
}

async function runToolCall(
  scenario: Scenario,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await handler(scenario, "tool_call")(
    { type: "tool_call", toolCallId: "call-1", toolName: "read", input },
    scenario.ctx,
  )
  return input
}

type Preparation = {
  firstKeptEntryId: string
  messagesToSummarize: Record<string, unknown>[]
  turnPrefixMessages: Record<string, unknown>[]
  isSplitTurn: boolean
  tokensBefore: number
  previousSummary?: string
  fileOps: { readFiles: string[]; modifiedFiles: string[] }
  settings: {
    enabled: boolean
    reserveTokens: number
    keepRecentTokens: number
  }
}

async function runCompaction(
  scenario: Scenario,
  preparation: Preparation,
): Promise<Preparation> {
  await handler(scenario, "session_before_compact")(
    {
      type: "session_before_compact",
      preparation,
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    },
    scenario.ctx,
  )
  return preparation
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function assertToken(value: unknown): void {
  assert.equal(typeof value, "string")
  assert.match(value as string, TOKEN_SHAPE)
}

function assertHasToken(value: unknown): void {
  assert.equal(typeof value, "string")
  assert.match(value as string, TOKEN_ANY)
}

describe("pi: configuration", () => {
  test("changes nothing when no config exists", async () => {
    await withScenario({}, async (scenario) => {
      const messages = [{ role: "user", content: "nothing sensitive" }]
      assert.equal(await runContextMaybe(scenario, messages), undefined)
      assert.equal(await runSystemPrompt(scenario, "base"), undefined)
    })
  })

  test("applies global and project rules together", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "global-word" } },
        projectRules: { p: { pattern: "project-word" } },
      },
      async (scenario) => {
        const [message] = await runContext(scenario, [
          { role: "user", content: "global-word project-word" },
        ])
        assertHasToken(asRecord(message).content)
      },
    )
  })

  test("skips a malformed project config but keeps the global one", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "global-word" } },
        projectRaw: "{ not json",
      },
      async (scenario) => {
        const [message] = await runContext(scenario, [
          { role: "user", content: "global-word" },
        ])
        assertToken(asRecord(message).content)
      },
    )
  })

  test("reloads when the project config changes", async () => {
    await withScenario(
      { projectRules: { a: { pattern: "alpha" } } },
      async (scenario) => {
        const [first] = await runContext(scenario, [
          { role: "user", content: "alpha" },
        ])
        assertToken(asRecord(first).content)

        writeFileSync(
          join(scenario.projectDir, "opencode-sanitizer.json"),
          JSON.stringify({ rules: { b: { pattern: "beta-word" } } }),
        )

        const [second] = await runContext(scenario, [
          { role: "user", content: "beta-word" },
        ])
        assertToken(asRecord(second).content)

        const [third] = await runContext(scenario, [
          { role: "user", content: "alpha" },
        ])
        assert.equal(asRecord(third).content, "alpha")
      },
    )
  })
})

describe("pi: request transforms", () => {
  test("appends the redaction notice to the system prompt", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const system = await runSystemPrompt(scenario, "base secret")
        assert.ok(system)
        assertHasToken(system)
        assert.ok((system as string).includes("Redaction notice"))
      },
    )
  })

  test("sanitizes user, assistant, and toolResult content", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const messages = await runContext(scenario, [
          { role: "user", content: "secret" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "secret" },
              { type: "thinking", thinking: "secret" },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "secret" }],
            isError: false,
          },
        ])
        assertToken(asRecord(messages[0]).content)
        const assistant = asRecord(messages[1])
        assertToken(asRecord((assistant.content as unknown[])[0]).text)
        assertToken(asRecord((assistant.content as unknown[])[1]).thinking)
        const toolResult = asRecord(messages[2])
        assertToken(asRecord((toolResult.content as unknown[])[0]).text)
        assert.equal(toolResult.toolName, "read")
        assert.equal(toolResult.toolCallId, "call-1")
        assert.equal(toolResult.isError, false)
      },
    )
  })

  test("sanitizes tool arguments but never tool identity", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const [message] = await runContext(scenario, [
          {
            role: "assistant",
            model: "secret-model",
            provider: "secret-provider",
            stopReason: "secret-stop",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "secret-tool",
                namespace: "secret-namespace",
                arguments: { path: "secret", nested: { id: "secret" } },
              },
            ],
          },
        ])
        const assistant = asRecord(message)
        assert.equal(assistant.model, "secret-model")
        assert.equal(assistant.provider, "secret-provider")
        assert.equal(assistant.stopReason, "secret-stop")
        const call = asRecord((assistant.content as unknown[])[0])
        assert.equal(call.id, "call-1")
        assert.equal(call.name, "secret-tool")
        assert.equal(call.namespace, "secret-namespace")
        const args = asRecord(call.arguments)
        assertToken(args.path)
        assertToken(asRecord(args.nested).id)
      },
    )
  })

  test("leaves JSON-schema payloads untouched", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const parameters = {
          type: "object",
          properties: { secretPath: { type: "string" } },
          enum: ["secret"],
          default: "secret",
        }
        const [message] = await runContext(scenario, [
          {
            role: "system",
            content: "secret instructions",
            sections: { guidance: "secret" },
            toolsAdded: [
              {
                name: "secret-tool",
                description: "secret description",
                parameters,
              },
            ],
          },
        ])
        const system = asRecord(message)
        assertHasToken(system.content)
        assertToken(asRecord(system.sections).guidance)
        const tool = asRecord((system.toolsAdded as unknown[])[0])
        assert.equal(tool.name, "secret-tool")
        assertHasToken(tool.description)
        assert.deepEqual(tool.parameters, parameters)
      },
    )
  })

  test("scrubs tool declarations in the full transcript", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const parameters = {
          type: "object",
          properties: { secretPath: { type: "string" } },
          enum: ["secret"],
        }
        const messages = [
          {
            role: "system",
            content: "base secret",
            toolsAdded: [
              {
                name: "secret-tool",
                description: "secret description",
                parameters,
              },
            ],
          },
          { role: "user", content: "secret" },
        ]
        const result = await runContextWithSystem(scenario, messages)
        const system = asRecord(result[0])
        assert.equal(system.role, "system")
        const tool = asRecord((system.toolsAdded as unknown[])[0])
        assert.equal(tool.name, "secret-tool")
        assertHasToken(tool.description)
        assert.deepEqual(tool.parameters, parameters)
        // Non-system messages belong to the `context` handler.
        assert.equal(asRecord(result[1]).content, "secret")
      },
    )
  })

  test("sanitizes compaction transcript and previous summary", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const preparation = await runCompaction(scenario, {
          firstKeptEntryId: "entry-1",
          messagesToSummarize: [{ role: "user", content: "secret" }],
          turnPrefixMessages: [{ role: "assistant", content: "secret" }],
          isSplitTurn: true,
          tokensBefore: 10,
          previousSummary: "secret previous",
          fileOps: { readFiles: [], modifiedFiles: [] },
          settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 },
        })
        assertToken(asRecord(preparation.messagesToSummarize[0]).content)
        assertToken(asRecord(preparation.turnPrefixMessages[0]).content)
        assertHasToken(preparation.previousSummary)
      },
    )
  })
})

describe("pi: restoration", () => {
  test("round-trips messages through message_end", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const [sanitized] = await runContext(scenario, [
          {
            role: "assistant",
            content: [
              { type: "text", text: "secret" },
              {
                type: "toolCall",
                id: "c",
                name: "read",
                arguments: { path: "secret" },
              },
            ],
          },
        ])
        const restored = await runMessageEnd(
          scenario,
          sanitized as Record<string, unknown>,
        )
        const content = restored.content as unknown[]
        assert.equal(asRecord(content[0]).text, "secret")
        assert.equal(asRecord(asRecord(content[1]).arguments).path, "secret")
      },
    )
  })

  test("leaves messages without tokens untouched", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const message = { role: "user", content: "harmless" }
        const result = (await handler(scenario, "message_end")(
          { type: "message_end", message },
          scenario.ctx,
        )) as { message?: unknown } | undefined
        assert.equal(result, undefined)
      },
    )
  })

  test("restores tokens in tool arguments before execution", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async (scenario) => {
        const [sanitized] = await runContext(scenario, [
          { role: "user", content: "secret" },
        ])
        const token = asRecord(sanitized).content as string
        assertToken(token)
        const args = await runToolCall(scenario, {
          path: token,
          nested: { value: `${token}!` },
        })
        assert.deepEqual(args, {
          path: "secret",
          nested: { value: "secret!" },
        })
      },
    )
  })
})
