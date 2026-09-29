# opencode-sanitizer

[English](README.md) | [中文](README.CN.md)

> Swap out the strings that would trip your provider's moderation, before the request goes out.

It ships as an [opencode](https://opencode.ai) plugin and as a
[pi coding agent](https://github.com/earendil-works/pi) extension; both share one
config and one rule set.

## Why this exists

It is not about stopping you from uploading private keys. It is about never again
being sickened by some provider's utterly inexplicable sensitive-word moderation.

It usually plays out like this: you're working smoothly in a session, when all of a
sudden a request comes back slapped across the face:

```
HTTP 400 Bad Request
```

You comb through the context and can't for the life of you find what's wrong --
maybe a variable name, maybe a comment, maybe some perfectly ordinary word in a
log, maybe just a completely normal sentence. But the provider's sensitive-word
system has decided it's a problem, and it won't tell you why.

If it were a one-off error, fine. The fatal part is that the content is already in
the conversation history: next turn the agent resends it verbatim, moderation sees
the same string again, so it's another 400; and the turn after that, another. You
are pinned in place -- you can't continue, you can't retry, and you can't carve
that one message out to delete it. An hour of context, gone; your only move is to
throw the whole session away and start over.

Once or twice you can put up with it. Do it enough times and you want to smash the
keyboard. This plugin exists because it happened far too many times.

`opencode-sanitizer` doesn't judge what should or shouldn't be moderated. It does
exactly one thing: before opencode actually packages the context up and sends it
to the provider, it **swaps out** every string that matches your rules for a
reversible placeholder token. Moderation never sees the thing that set it off,
the session sails on, and whenever the model echoes one of those tokens back, the
original string is quietly restored -- so your stored session still reads
normally.

Incidentally, you can absolutely use it to block keys, tokens, and private keys
too -- but that's just a side use of the same capability, not the original
motivation.

> On its place: it's a seatbelt, not a vault. It's for rescuing yourself from
> capricious content moderation and accidental leakage -- a best-effort guardrail,
> not a strict security boundary.

## How it works

Before opencode assembles a single LLM request, it fires a series of "transform
hooks". This plugin attaches to several of them:

- `experimental.chat.messages.transform` -- deep-scrubs each message: every
  string in the message info and in all parts (`text`, `reasoning`, `subtask`,
  `tool` state including `raw` and `attachments`, `file` filename/source, `patch`
  files, `agent`, `retry` errors), skipping only protocol identifiers such as
  ids, `type`, `role`, `tool`, `agent`, `status`, `url`, and `mime`.
- `experimental.chat.system.transform` -- scrubs each entry of the finally
  assembled system prompt, then appends a redaction notice telling the model that
  any `<HINT:HASH>` token is opaque and irreversible.
- `experimental.session.compacting` -- scrubs the compaction context and prompt.
- `tool.definition` -- scrubs the tool description that is sent to the model.
- `experimental.text.complete` -- restores tokens in the assistant's finished
  prose before it is stored.
- `tool.execute.before` -- restores tokens in tool arguments, so tools receive
  the real values instead of a placeholder.

So user messages, the assistant's prose and reasoning, tool output/input/metadata,
file parts, tool descriptions, compaction prompts, and the system prompt all get a
pass through your rules at the moment they go out; and assistant text plus tool
arguments get a reverse pass on the way back in.

### The same job on the pi coding agent

Pi's extension API exposes the same two moments. `dist/pi.js` is a pi extension
that registers on six events:

| Timing                          | opencode hook                           | pi event                 |
| ------------------------------- | --------------------------------------- | ------------------------ |
| System prompt                   | `experimental.chat.system.transform`    | `before_agent_start`     |
| Outbound conversation           | `experimental.chat.messages.transform`  | `context`                |
| Tool declarations               | `tool.definition`                       | `context_with_system`    |
| Compaction input                | `experimental.session.compacting`       | `session_before_compact` |
| Assistant text before storage   | `experimental.text.complete`            | `message_end`            |
| Tool arguments before execution | `tool.execute.before`                   | `tool_call`              |

`context` and `session_before_compact` changes are request-local: only the
outgoing model call sees the tokens, and the session file keeps its originals.
`message_end` replaces a finalized message before it is stored, and `tool_call`
puts the real values back into the arguments a tool receives. Pi's structural keys
(tool names, call ids, providers, stop reasons) and opaque payloads (JSON-schema
`parameters`, base64 `data`, usage/cost) are never rewritten, for the same reason
as in opencode: rewriting them would break the request instead of hiding content.

Pi's `session_before_compact` can sanitize the transcript handed to the
summarizer, but the API gives no way to rewrite the summary the summarizer writes
back, and a `/compact` custom instruction is captured before the hook runs. A
token the model copies into a compaction summary therefore stays in the session
file; everything else round-trips.

### Why there is no opencode v2 support

opencode v2 replaced the v1 hook object with a domain hook API. The outbound half
maps cleanly -- `ctx.session.hook("context")` for system/messages/tools and
`ctx.tool.hook("execute.before")` for tool arguments -- but v2 dropped
`experimental.text.complete` and has no replacement. Nothing runs between the
assistant's finished prose and its durable write, so a token the model echoes back
would be written to the session file and could never be restored (the token map
does not survive a restart). The raw `http.response` hook could in principle
rewrite the streamed body, but it sees provider-specific JSON/SSE before parsing,
where substituting arbitrary restored text can corrupt the payload; a generic,
safe implementation is not possible. Since this plugin's entire contract is
reversibility, v2 is not supported rather than shipped in a one-way form.

`experimental.chat.messages.transform` already receives a copy of the context, so
only the outbound request is touched -- the session on disk keeps its originals.

Rules are declared as a map keyed by name, and each rule is just an ordinary
JavaScript regular expression (or a literal string). There is no replacement
field any more: each match is replaced by `<HINT:HASH>`. `HASH` is a random 16
hex character id, unique within the process and **not derived from the matched
text** (so it cannot be used to confirm a guessed secret), and `HINT` is a fixed,
opaque, meaningless identifier (`6f1a3c8e-2b47-4d90-a15f-9c3e7b0d8214`) that is
not configurable. An earlier design let rules carry a descriptive hint and
derived `HASH` from the content; both ideas backfired. Models -- especially
reasoning models -- fixated on the hint and tried to recover the original text,
which is counterproductive: DeepSeek, for one, aborts the stream the moment a
sensitive word shows up in streaming reasoning. A content-derived hash also leaks
whether a guessed value was redacted. Removing the semantic hook, together with
the redaction notice injected into the system prompt (the "copy it verbatim,
don't decode it" instruction), keeps the model from trying to restore it. The
plugin keeps `id -> original` and `original -> id` maps in memory, so the same
string maps to the same token within a process, and the token can be turned back
into the original whenever the model sends it back. Every token the plugin has
emitted is treated as opaque and never rewritten by a rule, so a rule matching
UUIDs, hex runs, or angle brackets cannot corrupt a token and sanitizing stays
idempotent. Regex and
literal rules work identically; only capture-group replacement templates (`$1`,
`$&`) are gone. The `g` flag is always added automatically. Before each transform
the plugin checks the config file's mtime and only reparses it when it changes --
so you can add or remove rules mid-session without restarting.

Because the map lives only in the plugin's memory for the life of the process,
an un-restored token cannot be recovered after a restart. In practice the only
place a token can slip through un-restored is assistant `reasoning` parts, which
fire no transform hook -- they stay readable to the model but not to you.

## Configuration

The plugin reads two locations and considers **all** of their rules:

1. `$XDG_CONFIG_HOME/opencode-sanitizer/config.json` (or
   `~/.config/opencode-sanitizer/config.json` when `XDG_CONFIG_HOME` is unset) --
   the global config
2. `<opencode working directory>/opencode-sanitizer.json` -- the project config

Rule names are only labels for logs; they are never used to override or
deduplicate, so a name that appears in both files simply yields two independent
rules. **Every match from every rule is redacted, with no exception:** where two
matches overlap, they are merged and replaced by a single token spanning their
union, so no matched character can survive, not even as a fragment of a match
that "lost". Matches that do not overlap stay as separate tokens. File order and
the winner-takes-all heuristics of the earlier release are gone -- they could
leave fragments of a discarded match behind. When neither file exists, the rule
set is empty -- the plugin changes nothing and behaves exactly as if it weren't
installed. The
repository itself ships no default config either.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/lialh4qwq/opencode-sanitizer/main/sanitize.schema.json",
  "rules": {
    "false-positive-word": {
      "literal": true,
      "pattern": "sensitive-word"
    },
    "anthropic-api-key": {
      "pattern": "sk-ant-[A-Za-z0-9_-]{16,}"
    }
  }
}
```

Fields:

| Field                  | Meaning                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `rules`                | Map of rule name to rule; the key is the name shown in logs.                |
| `rules.<name>.pattern` | JavaScript regex source; treated as an exact string when `literal` is true. |
| `rules.<name>.flags`   | Regex flags; `g` is always added.                                           |
| `rules.<name>.literal` | Treat `pattern` as a literal instead of a regex.                            |

Every match is replaced by `<HINT:HASH>`, where `HINT` is the fixed opaque
identifier; there is no configurable replacement text or hint. See
`sanitize.schema.json` for the full schema.

## Installation

### Nix flake (recommended)

The flake exposes:

- `packages.<system>.opencode-sanitizer` and `packages.<system>.default`
- `overlays.opencode-sanitizer` and `overlays.default`
- `homeModules.opencode-sanitizer` and `homeModules.default`

Add the input, import the home-manager module, then opt each target in
independently -- the module brings its own package, so you don't have to wire up
the overlay yourself:

```nix
{
  inputs.opencode-sanitizer.url = "github:lialh4qwq/opencode-sanitizer";

  # in your home-manager configuration
  imports = [ inputs.opencode-sanitizer.homeModules.default ];

  services.opencode-sanitizer.opencode.enable = true;
}
```

The module drops two files into place:

- `~/.config/opencode/plugins/opencode-sanitizer.js` -- the plugin itself
- `~/.config/opencode-sanitizer/config.json` -- written only when `settings` is
  non-empty

Set `services.opencode-sanitizer.pi-coding-agent.enable = true` to also link the
pi extension into `~/.pi/agent/extensions/opencode-sanitizer.js`;
`pi-coding-agent.agentDir` overrides the agent directory (which pi otherwise
takes from `PI_CODING_AGENT_DIR`). Both targets read the same `settings` and the
same project-level `opencode-sanitizer.json`, and both are off by default.

Define global rules with `services.opencode-sanitizer.settings`; the project-level
`opencode-sanitizer.json` is yours to place in the working directory, and the two
apply together. `settings` is validated against `sanitize.schema.json` at build
time, so a malformed payload fails the switch instead of silently dropping a
rule. To swap out the package, just set
`services.opencode-sanitizer.package` (it is only a default). And if you'd rather
apply the overlay yourself, `overlays.opencode-sanitizer` / `overlays.default`
remain available.

### Manual (any opencode install)

Build first, then have `opencode.json` load the plugin:

```sh
pnpm install
pnpm build
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./dist/sanitizer.js"]
}
```

Put your rules in the working directory's `opencode-sanitizer.json`, or in
`~/.config/opencode-sanitizer/config.json`. opencode can load TypeScript directly
too, so during development you can point at `./src/sanitizer.ts`; alternatively,
drop the plugin into `.opencode/plugins/` (project) or
`~/.config/opencode/plugins/` (global) and let opencode auto-load it.

#### pi coding agent

The same build produces `dist/pi.js` (or point pi at `src/pi.ts` during
development). Drop it into `~/.pi/agent/extensions/` as
`opencode-sanitizer.js`, place it in a project's `.pi/extensions/`, or load it for
a single run:

```sh
pi --extension ./dist/pi.js
```

Rules come from the same two files; the project config is resolved against pi's
working directory.

## Development

The shared engine lives in `src/engine.ts`. `src/sanitizer.ts` (the opencode
plugin) and `src/pi.ts` (the pi extension) are bundled by
[rolldown](https://rolldown.rs) into the self-contained `dist/sanitizer.js` and
`dist/pi.js`; dependencies are managed with pnpm. Tests live in `test/` and run on
Node's built-in test runner (they import the TypeScript sources directly, so no
build step is needed):

```sh
pnpm install
pnpm build        # bundle to dist/
pnpm typecheck    # tsc --noEmit
pnpm test         # node --test test/
```

Nix:

```sh
nix flake check
nix build .#default
nix fmt
```
