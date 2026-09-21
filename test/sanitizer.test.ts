import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { SanitizerPlugin } from "../src/sanitizer.ts"

const TOKEN_SHAPE = /^<[^<>\s]+:\s*[0-9a-f]{16}>$/i

type Hooks = Awaited<ReturnType<typeof SanitizerPlugin>>

type LogEntry = { level: string; message: string; extra?: unknown }

type LooseMessagesHook = (
  input: unknown,
  output: { messages: { info: unknown; parts: unknown[] }[] },
) => Promise<void>
type LooseSystemHook = (
  input: unknown,
  output: { system: string[] },
) => Promise<void>
type LooseCompleteHook = (
  input: unknown,
  output: { text: string },
) => Promise<void>
type LooseToolHook = (
  input: unknown,
  output: { args: unknown },
) => Promise<void>
type LooseCompactingHook = (
  input: unknown,
  output: { context: string[]; prompt?: string },
) => Promise<void>
type LooseToolDefinitionHook = (
  input: unknown,
  output: { description: string; parameters: unknown },
) => Promise<void>

type ScenarioOptions = {
  globalRules?: Record<string, unknown>
  projectRules?: Record<string, unknown>
  globalRaw?: string
  projectRaw?: string
}

type Scenario = {
  hooks: Hooks
  logs: LogEntry[]
  projectDir: string
  cleanup: () => void
}

async function createScenario(
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const globalRoot = mkdtempSync(join(tmpdir(), "sanitizer-global-"))
  const projectDir = mkdtempSync(join(tmpdir(), "sanitizer-project-"))
  const logs: LogEntry[] = []
  const previousXdg = process.env.XDG_CONFIG_HOME

  const globalConfigDir = join(globalRoot, "opencode-sanitizer")
  mkdirSync(globalConfigDir, { recursive: true })
  if (options.globalRaw !== undefined) {
    writeFileSync(join(globalConfigDir, "config.json"), options.globalRaw)
  } else if (options.globalRules !== undefined) {
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

  const client = {
    app: {
      log: async (input: { body: LogEntry & { service: string } }) => {
        logs.push({
          level: input.body.level,
          message: input.body.message,
          extra: input.body.extra,
        })
      },
    },
  }

  const hooks = await SanitizerPlugin({
    directory: projectDir,
    client,
  } as unknown as Parameters<typeof SanitizerPlugin>[0])

  return {
    hooks,
    logs,
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

type TestMessage = { info: unknown; parts: unknown[] }

async function transformMessages(
  hooks: Hooks,
  messages: TestMessage[],
): Promise<TestMessage[]> {
  const hook = hooks[
    "experimental.chat.messages.transform"
  ] as unknown as LooseMessagesHook
  const output = { messages }
  await hook({}, output)
  return output.messages
}

async function sanitizeParts(
  hooks: Hooks,
  parts: unknown[],
): Promise<unknown[]> {
  const messages = await transformMessages(hooks, [{ info: {}, parts }])
  return messages[0].parts
}

async function sanitizeText(hooks: Hooks, text: string): Promise<string> {
  const parts = await sanitizeParts(hooks, [{ type: "text", text }])
  return (parts[0] as { text: string }).text
}

async function sanitizeSystem(
  hooks: Hooks,
  system: string[],
): Promise<string[]> {
  const hook = hooks[
    "experimental.chat.system.transform"
  ] as unknown as LooseSystemHook
  const output = { system }
  await hook({}, output)
  return output.system
}

async function completeText(hooks: Hooks, text: string): Promise<string> {
  const hook = hooks[
    "experimental.text.complete"
  ] as unknown as LooseCompleteHook
  const output = { text }
  await hook({}, output)
  return output.text
}

async function restoreArgs(hooks: Hooks, args: unknown): Promise<unknown> {
  const hook = hooks["tool.execute.before"] as unknown as LooseToolHook
  const output = { args }
  await hook({}, output)
  return output.args
}

async function compact(
  hooks: Hooks,
  output: { context: string[]; prompt?: string },
): Promise<{ context: string[]; prompt?: string }> {
  const hook = hooks[
    "experimental.session.compacting"
  ] as unknown as LooseCompactingHook
  await hook({}, output)
  return output
}

async function defineTool(
  hooks: Hooks,
  output: { description: string; parameters: unknown },
): Promise<{ description: string; parameters: unknown }> {
  const hook = hooks["tool.definition"] as unknown as LooseToolDefinitionHook
  await hook({}, output)
  return output
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function assertToken(value: string): void {
  assert.match(value, TOKEN_SHAPE)
}

async function roundTrip(hooks: Hooks, text: string): Promise<string> {
  const sanitized = await sanitizeText(hooks, text)
  assert.equal(await completeText(hooks, sanitized), text)
  return sanitized
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = [
  "a",
  "b",
  "c",
  "x",
  "secret",
  "6f",
  "1a",
  "deadbeef",
  "0123456789abcdef",
  "<",
  ">",
  ":",
  " ",
  "-",
  "0",
  "9",
]

function randomText(rand: () => number, maxPieces = 12): string {
  const count = Math.floor(rand() * (maxPieces + 1))
  let out = ""
  for (let index = 0; index < count; index++) {
    out += PIECES[Math.floor(rand() * PIECES.length)]
  }
  return out
}

describe("configuration", () => {
  test("changes nothing when no config exists", async () => {
    await withScenario({}, async ({ hooks }) => {
      const text = "nothing sensitive here"
      assert.equal(await sanitizeText(hooks, text), text)
      assert.deepEqual(await sanitizeSystem(hooks, ["base"]), ["base"])
    })
  })

  test("applies project and global rules together", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "global-word" } },
        projectRules: { p: { pattern: "project-word" } },
      },
      async ({ hooks }) => {
        assertToken(await roundTrip(hooks, "global-word"))
        assertToken(await roundTrip(hooks, "project-word"))
      },
    )
  })

  test("skips a malformed config but keeps the other", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "global-word" } },
        projectRaw: "{ this is not json",
      },
      async ({ hooks, logs }) => {
        assertToken(await roundTrip(hooks, "global-word"))
        assert.ok(
          logs.some(
            (entry) =>
              entry.level === "warn" &&
              entry.message.includes("failed to load config"),
          ),
        )
      },
    )
  })

  test("skips an invalid regex and logs a warning", async () => {
    await withScenario(
      { projectRules: { bad: { pattern: "(" } } },
      async ({ hooks, logs }) => {
        assert.equal(await sanitizeText(hooks, "abc"), "abc")
        assert.ok(
          logs.some(
            (entry) =>
              entry.level === "warn" &&
              entry.message.includes('invalid pattern for rule "bad"'),
          ),
        )
      },
    )
  })

  test("reloads when a config file changes", async () => {
    await withScenario(
      { projectRules: { a: { pattern: "alpha" } } },
      async ({ hooks, projectDir }) => {
        assertToken(await roundTrip(hooks, "alpha"))
        writeFileSync(
          join(projectDir, "opencode-sanitizer.json"),
          JSON.stringify({ rules: { b: { pattern: "beta-word" } } }),
        )
        assertToken(await roundTrip(hooks, "beta-word"))
        assert.equal(await sanitizeText(hooks, "alpha"), "alpha")
      },
    )
  })

  test("omits the redaction notice when no rules exist", async () => {
    await withScenario({ projectRules: {} }, async ({ hooks }) => {
      assert.deepEqual(await sanitizeSystem(hooks, ["base"]), ["base"])
    })
  })

  test("appends the redaction notice when rules exist", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const system = await sanitizeSystem(hooks, ["base"])
        assert.equal(system.length, 2)
        assert.equal(system[0], "base")
        assert.ok(system[1].includes("Redaction notice"))
        assert.ok(system[1].includes("<HINT:HASH>"))
      },
    )
  })

  test("sanitizes system entries before appending the notice", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "base" } } },
      async ({ hooks }) => {
        const system = await sanitizeSystem(hooks, ["base"])
        assertToken(system[0])
        assert.ok(system[1].includes("Redaction notice"))
      },
    )
  })
})

describe("part sanitization", () => {
  test("sanitizes text and reasoning parts", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const parts = await sanitizeParts(hooks, [
          { type: "text", text: "secret" },
          { type: "reasoning", text: "secret" },
        ])
        assertToken(asRecord(parts[0]).text as string)
        assertToken(asRecord(parts[1]).text as string)
      },
    )
  })

  test("sanitizes subtask prompt and description", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const parts = await sanitizeParts(hooks, [
          { type: "subtask", prompt: "secret", description: "secret" },
        ])
        assertToken(asRecord(parts[0]).prompt as string)
        assertToken(asRecord(parts[0]).description as string)
      },
    )
  })

  test("sanitizes tool state and metadata", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const parts = await sanitizeParts(hooks, [
          {
            type: "tool",
            state: {
              output: "secret",
              error: "secret",
              title: "secret",
              input: { path: "secret" },
              metadata: { note: "secret" },
            },
            metadata: { extra: "secret" },
          },
        ])
        const state = asRecord(asRecord(parts[0]).state)
        assertToken(state.output as string)
        assertToken(state.error as string)
        assertToken(state.title as string)
        assertToken(asRecord(state.input).path as string)
        assertToken(asRecord(state.metadata).note as string)
        assertToken(asRecord(asRecord(parts[0]).metadata).extra as string)
      },
    )
  })

  test("sanitizes file source text", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const parts = await sanitizeParts(hooks, [
          { type: "file", source: { text: { value: "secret" } } },
        ])
        const source = asRecord(asRecord(parts[0]).source)
        assertToken(asRecord(source.text).value as string)
      },
    )
  })
})

describe("coverage", () => {
  const SECRET = { projectRules: { p: { pattern: "secret" } } }

  test("sanitizes message.info summary and system", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const [message] = await transformMessages(hooks, [
        {
          info: {
            id: "msg-1",
            sessionID: "ses-1",
            role: "user",
            agent: "build",
            model: { providerID: "openai", modelID: "gpt" },
            summary: { title: "secret", body: "secret", diffs: [] },
            system: "secret",
          },
          parts: [],
        },
      ])
      const info = asRecord(message.info)
      assertToken(asRecord(info.summary).title as string)
      assertToken(asRecord(info.summary).body as string)
      assertToken(info.system as string)
      assert.equal(info.id, "msg-1")
      assert.equal(info.sessionID, "ses-1")
      assert.equal(info.role, "user")
      assert.equal(info.agent, "build")
    })
  })

  test("sanitizes tool state raw and attachments", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const parts = await sanitizeParts(hooks, [
        {
          type: "tool",
          id: "part-1",
          callID: "call-1",
          tool: "read",
          state: { status: "pending", input: {}, raw: "secret" },
        },
        {
          type: "tool",
          id: "part-2",
          callID: "call-2",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "",
            metadata: {},
            attachments: [
              {
                type: "file",
                id: "file-1",
                filename: "secret",
                url: "https://example.com/x",
                mime: "text/plain",
                source: {
                  text: { value: "secret" },
                  type: "file",
                  path: "secret",
                },
              },
            ],
          },
        },
      ])
      const pending = asRecord(asRecord(parts[0]).state)
      assertToken(pending.raw as string)
      assert.equal(pending.status, "pending")
      const attachment = asRecord(
        (asRecord(asRecord(parts[1]).state).attachments as unknown[])[0],
      )
      assertToken(attachment.filename as string)
      assert.equal(attachment.url, "https://example.com/x")
      assert.equal(attachment.mime, "text/plain")
      assertToken(asRecord(asRecord(attachment.source).text).value as string)
    })
  })

  test("sanitizes file part filename and symbol source", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const parts = await sanitizeParts(hooks, [
        {
          type: "file",
          id: "file-1",
          filename: "secret",
          url: "https://example.com/x",
          mime: "text/plain",
          source: {
            type: "symbol",
            path: "secret",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            name: "secret",
            kind: 12,
            text: { value: "secret" },
          },
        },
      ])
      const part = asRecord(parts[0])
      assertToken(part.filename as string)
      const source = asRecord(part.source)
      assertToken(source.path as string)
      assertToken(source.name as string)
      assertToken(asRecord(source.text).value as string)
      assert.equal(part.url, "https://example.com/x")
    })
  })

  test("sanitizes patch files and agent parts", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const parts = await sanitizeParts(hooks, [
        { type: "patch", id: "p", hash: "h", files: ["secret", "keep"] },
        { type: "agent", id: "a", name: "secret", source: { value: "secret" } },
      ])
      assertToken((asRecord(parts[0]).files as string[])[0])
      assert.equal((asRecord(parts[0]).files as string[])[1], "keep")
      const agent = asRecord(parts[1])
      assertToken(agent.name as string)
      assertToken(asRecord(agent.source).value as string)
    })
  })

  test("sanitizes retry errors", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const parts = await sanitizeParts(hooks, [
        {
          type: "retry",
          id: "r",
          attempt: 1,
          error: { name: "APIError", data: { message: "secret" } },
        },
      ])
      const error = asRecord(asRecord(parts[0]).error)
      assertToken(asRecord(error.data).message as string)
    })
  })

  test("sanitizes a free-form key nested in tool input", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const parts = await sanitizeParts(hooks, [
        {
          type: "tool",
          id: "part",
          callID: "call",
          tool: "fetch",
          state: { status: "completed", input: { url: "secret" } },
        },
      ])
      const state = asRecord(asRecord(parts[0]).state)
      assertToken(asRecord(state.input).url as string)
    })
  })

  test("never rewrites structural identifiers", async () => {
    await withScenario(
      { projectRules: { word: { pattern: "\\w+" } } },
      async ({ hooks }) => {
        const [message] = await transformMessages(hooks, [
          {
            info: {
              id: "abc123",
              sessionID: "sess1",
              role: "user",
              agent: "build",
              model: { providerID: "openai", modelID: "gpt" },
            },
            parts: [
              {
                type: "tool",
                id: "part1",
                callID: "call1",
                tool: "read",
                state: {
                  status: "completed",
                  input: { secret: "secret" },
                  output: "secret",
                  title: "secret",
                },
              },
            ],
          },
        ])
        const info = asRecord(message.info)
        assert.equal(info.id, "abc123")
        assert.equal(info.sessionID, "sess1")
        assert.equal(info.role, "user")
        assert.equal(info.agent, "build")
        assert.deepEqual(info.model, { providerID: "openai", modelID: "gpt" })
        const part = asRecord(message.parts[0])
        assert.equal(part.id, "part1")
        assert.equal(part.callID, "call1")
        assert.equal(part.tool, "read")
        const state = asRecord(part.state)
        assert.equal(state.status, "completed")
        assertToken(asRecord(state.input).secret as string)
        assertToken(state.output as string)
        assertToken(state.title as string)
      },
    )
  })

  test("sanitizes compaction context and prompt", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const output = await compact(hooks, {
        context: ["secret"],
        prompt: "secret",
      })
      assertToken(output.context[0])
      assertToken(output.prompt as string)
    })
  })

  test("sanitizes tool definition description but not parameters", async () => {
    await withScenario(SECRET, async ({ hooks }) => {
      const parameters = {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      }
      const output = await defineTool(hooks, {
        description: "secret",
        parameters,
      })
      assertToken(output.description)
      assert.deepEqual(output.parameters, parameters)
    })
  })
})

describe("rules", () => {
  test("supports literal patterns", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "a.b", literal: true } } },
      async ({ hooks }) => {
        assertToken(await roundTrip(hooks, "a.b"))
        assert.equal(await sanitizeText(hooks, "axb"), "axb")
      },
    )
  })

  test("supports regular expression flags", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret", flags: "i" } } },
      async ({ hooks }) => {
        const value = await roundTrip(hooks, "SECRET")
        assertToken(value)
      },
    )
  })

  test("maps identical text to an identical token", async () => {
    await withScenario(
      {
        projectRules: {
          p: { pattern: "secret" },
          q: { pattern: "different" },
        },
      },
      async ({ hooks }) => {
        const first = await sanitizeText(hooks, "secret")
        const second = await sanitizeText(hooks, "secret")
        const other = await sanitizeText(hooks, "different")
        assertToken(first)
        assert.equal(first, second)
        assert.notEqual(first, other)
      },
    )
  })

  test("ignores zero-length matches", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "" } } },
      async ({ hooks }) => {
        assert.equal(await sanitizeText(hooks, "abc"), "abc")
      },
    )
  })
})

describe("overlap merging", () => {
  test("merges the union of two partially overlapping matches", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "abcde" } },
        projectRules: { p: { pattern: "cdefg" } },
      },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "abcdefg")
        assertToken(value)
        assert.equal(await completeText(hooks, value), "abcdefg")
      },
    )
  })

  test("merges a match contained in a wider one", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "hello world" } },
        projectRules: { p: { pattern: "world" } },
      },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "hello world")
        assertToken(value)
        assert.equal(await completeText(hooks, value), "hello world")
      },
    )
  })

  test("merges regardless of which config holds the wider match", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "world" } },
        projectRules: { p: { pattern: "hello world" } },
      },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "hello world")
        assertToken(value)
        assert.equal(await completeText(hooks, value), "hello world")
      },
    )
  })

  test("merges a chain of overlapping matches", async () => {
    await withScenario(
      {
        projectRules: {
          short: { pattern: "foo" },
          long: { pattern: "foobar" },
        },
      },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "foobar")
        assertToken(value)
        assert.equal(await completeText(hooks, value), "foobar")
      },
    )
  })

  test("keeps non-overlapping matches as separate tokens", async () => {
    await withScenario(
      {
        globalRules: { g: { pattern: "cat" } },
        projectRules: { p: { pattern: "dog" } },
      },
      async ({ hooks }) => {
        assert.equal(
          await sanitizeText(hooks, "cat dog"),
          `${await sanitizeText(hooks, "cat")} ${await sanitizeText(hooks, "dog")}`,
        )
      },
    )
  })

  test("does not re-tokenize an already generated token", async () => {
    await withScenario(
      {
        globalRules: {
          word: { pattern: "secret" },
          hex: { pattern: "[0-9a-f]{16}" },
        },
      },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "secret")
        assertToken(value)
        assert.equal(await sanitizeText(hooks, value), value)
      },
    )
  })
})

describe("token protection", () => {
  const ADVERSARIAL = {
    globalRules: {
      hex: { pattern: "[0-9a-f]{16}" },
      hint: { pattern: "6f1a3c8e-2b47-4d90-a15f-9c3e7b0d8214" },
      brackets: { pattern: "<[^>]*>" },
      colon: { pattern: "[<>:]" },
    },
    projectRules: {
      word: { pattern: "\\w+" },
      secret: { pattern: "secret" },
    },
  }

  test("existing tokens are never rewritten by hostile rules", async () => {
    await withScenario(ADVERSARIAL, async ({ hooks }) => {
      const value = await sanitizeText(hooks, "secret")
      assertToken(value)
      assert.equal(await sanitizeText(hooks, value), value)
      assert.equal(await sanitizeText(hooks, `~${value}~`), `~${value}~`)
      assert.equal(await completeText(hooks, value), "secret")
    })
  })

  test("does not shield token-shaped text that is not ours", async () => {
    await withScenario(
      { projectRules: { hex: { pattern: "[0-9a-f]{16}" } } },
      async ({ hooks }) => {
        const text = "<x:0123456789abcdef>"
        const sanitized = await sanitizeText(hooks, text)
        assert.notEqual(sanitized, text)
        assert.equal(await completeText(hooks, sanitized), text)
      },
    )
  })

  test("sanitize stays idempotent under hostile rules", async () => {
    await withScenario(ADVERSARIAL, async ({ hooks }) => {
      const rand = mulberry32(0xc0ffee)
      for (let index = 0; index < 300; index++) {
        const text = randomText(rand, 16)
        const once = await sanitizeText(hooks, text)
        assert.equal(await sanitizeText(hooks, once), once)
      }
    })
  })
})

describe("restoration", () => {
  test("restores tokens in completed assistant text", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "secret")
        assert.equal(
          await completeText(hooks, `before ${value} after`),
          "before secret after",
        )
      },
    )
  })

  test("restores tokens in tool arguments", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "secret")
        const args = await restoreArgs(hooks, {
          path: value,
          list: [value, "keep"],
          nested: { value: `${value}!` },
        })
        assert.deepEqual(args, {
          path: "secret",
          list: ["secret", "keep"],
          nested: { value: "secret!" },
        })
      },
    )
  })

  test("restores deep tool arguments without a depth limit", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "secret")
        let nested: unknown = value
        for (let index = 0; index < 64; index++) nested = { next: nested }
        const restored = await restoreArgs(hooks, nested)
        let cursor = restored
        for (let index = 0; index < 64; index++) {
          cursor = asRecord(cursor).next
        }
        assert.equal(cursor, "secret")
      },
    )
  })

  test("leaves unknown tokens untouched", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const unknown = "<unknown:0123456789abcdef>"
        assert.equal(await completeText(hooks, unknown), unknown)
      },
    )
  })

  test("tolerates uppercase ids and extra spacing", async () => {
    await withScenario(
      { projectRules: { p: { pattern: "secret" } } },
      async ({ hooks }) => {
        const value = await sanitizeText(hooks, "secret")
        assert.equal(await completeText(hooks, value.toUpperCase()), "secret")
        assert.equal(
          await completeText(hooks, value.replace(":", " : ")),
          "secret",
        )
      },
    )
  })

  test("round-trips sanitize and restore", async () => {
    await withScenario(
      {
        projectRules: {
          a: { pattern: "alpha" },
          b: { pattern: "beta" },
        },
      },
      async ({ hooks }) => {
        const source = "alpha beta alpha"
        const sanitized = await sanitizeText(hooks, source)
        assert.notEqual(sanitized, source)
        assert.equal(await completeText(hooks, sanitized), source)
      },
    )
  })
})

describe("properties", () => {
  const SINGLE_RULES: Record<string, unknown> = {
    "literal-abc": { pattern: "abc", literal: true },
    hex16: { pattern: "[0-9a-f]{16}" },
    word: { pattern: "\\w+" },
    hint: { pattern: "6f1a3c8e-2b47-4d90-a15f-9c3e7b0d8214" },
    brackets: { pattern: "<[^>]*>" },
    colon: { pattern: "[<>:]" },
  }

  for (const [name, rule] of Object.entries(SINGLE_RULES)) {
    test(`single rule round-trips: ${name}`, async () => {
      await withScenario(
        { projectRules: { [name]: rule } },
        async ({ hooks }) => {
          const rand = mulberry32(0x9e3779b9)
          for (let index = 0; index < 300; index++) {
            const text = randomText(rand)
            const sanitized = await sanitizeText(hooks, text)
            assert.equal(await completeText(hooks, sanitized), text)
          }
        },
      )
    })
  }

  test("overlapping rules still round-trip", async () => {
    await withScenario(
      {
        globalRules: {
          hex: { pattern: "[0-9a-f]{16}" },
          hint: { pattern: "6f1a3c8e-2b47-4d90-a15f-9c3e7b0d8214" },
          brackets: { pattern: "<[^>]*>" },
        },
        projectRules: {
          word: { pattern: "\\w+" },
          colon: { pattern: "[<>:]" },
        },
      },
      async ({ hooks }) => {
        const rand = mulberry32(0x1234abcd)
        for (let index = 0; index < 300; index++) {
          const text = randomText(rand, 16)
          const sanitized = await sanitizeText(hooks, text)
          assert.equal(await completeText(hooks, sanitized), text)
        }
      },
    )
  })
})
