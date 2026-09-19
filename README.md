# opencode-sanitizer

[English](README.md) | [中文](README.CN.md)

> Swap out the strings that would trip your provider's moderation, before the request goes out.

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
the conversation history: next turn opencode resends it verbatim, moderation sees
the same string again, so it's another 400; and the turn after that, another. You
are pinned in place -- you can't continue, you can't retry, and you can't carve
that one message out to delete it. An hour of context, gone; your only move is to
throw the whole session away and start over.

Once or twice you can put up with it. Do it enough times and you want to smash the
keyboard. This plugin exists because it happened far too many times.

`opencode-sanitizer` doesn't judge what should or shouldn't be moderated. It does
exactly one thing: before opencode actually packages the context up and sends it
to the provider, it **rewrites in place** every string that matches your rules.
Moderation never sees the thing that set it off, and the session sails on.

Incidentally, you can absolutely use it to block keys, tokens, and private keys
too -- but that's just a side use of the same capability, not the original
motivation.

> On its place: it's a seatbelt, not a vault. It's for rescuing yourself from
> capricious content moderation and accidental leakage -- a best-effort guardrail,
> not a strict security boundary.

## How it works

Before opencode assembles a single LLM request, it fires a series of "transform
hooks". This plugin attaches to two of them:

- `experimental.chat.messages.transform` -- walks every message, part by part
  (`text`, `reasoning`, `subtask`, `tool` state, `file` source), rewriting the
  text within.
- `experimental.chat.system.transform` -- scrubs each entry of the finally
  assembled system prompt.

So user messages, the assistant's prose and reasoning, tool output/input/metadata,
file parts, and the system prompt all get a pass through your rules at the moment
they go out.

A rule is just an ordinary JavaScript regular expression (or a literal string)
plus a replacement; the `g` flag is always added automatically. Before each
transform the plugin checks the config file's mtime and only reparses it when it
changes -- so you can add or remove rules mid-session without restarting.

## Configuration

The plugin reads two locations at once and **merges** their rules so both take
effect, with no ordering and no overriding between them:

1. `<opencode working directory>/opencode-sanitizer.json`
2. `$XDG_CONFIG_HOME/opencode-sanitizer/config.json` (or
   `~/.config/opencode-sanitizer/config.json` when `XDG_CONFIG_HOME` is unset)

When neither file exists, the rule set is empty -- the plugin changes nothing and
behaves exactly as if it weren't installed. The repository itself ships no default
config either.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/anomalyco/opencode-sanitizer/main/sanitize.schema.json",
  "rules": [
    {
      "name": "false-positive-word",
      "literal": true,
      "pattern": "sensitive-word",
      "replacement": "[FUZZY]"
    },
    {
      "name": "anthropic-api-key",
      "pattern": "sk-ant-[A-Za-z0-9_-]{16,}",
      "replacement": "[REDACTED_ANTHROPIC_KEY]"
    }
  ]
}
```

Fields:

| Field         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `name`        | A readable name to recognize the rule in logs.                              |
| `pattern`     | JavaScript regex source; treated as an exact string when `literal` is true. |
| `flags`       | Regex flags; `g` is always added.                                           |
| `replacement` | Replacement text; supports `$1`, `$2`, `$&`, `$$`. Defaults to empty.       |
| `literal`     | Treat `pattern` as a literal instead of a regex.                            |

See `sanitize.schema.json` for the full schema.

## Installation

### Nix flake (recommended)

The flake exposes:

- `packages.<system>.opencode-sanitizer` and `packages.<system>.default`
- `overlays.opencode-sanitizer` and `overlays.default`
- `homeModules.opencode-sanitizer` and `homeModules.default`

Add the input, import the home-manager module, flip it on -- the module brings its
own package, so you don't have to wire up the overlay yourself:

```nix
{
  inputs.opencode-sanitizer.url = "github:anomalyco/opencode-sanitizer";

  # in your home-manager configuration
  imports = [ inputs.opencode-sanitizer.homeModules.default ];

  services.opencode-sanitizer.enable = true;
}
```

The module drops two files into place:

- `~/.config/opencode/plugins/opencode-sanitizer.js` -- the plugin itself
- `~/.config/opencode-sanitizer/config.json` -- written only when `settings` is
  non-empty

Define global rules with `services.opencode-sanitizer.settings`; the project-level
`opencode-sanitizer.json` is yours to place in the working directory, and the two
apply together. To swap out the package, just set
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

## Development

The source lives in `src/sanitizer.ts` and is bundled by
[rolldown](https://rolldown.rs) into `dist/sanitizer.js`; dependencies are managed
with pnpm:

```sh
pnpm install
pnpm build        # bundle to dist/
pnpm typecheck    # tsc --noEmit
```

Nix:

```sh
nix flake check
nix build .#default
nix fmt
```
