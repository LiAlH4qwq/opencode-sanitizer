# opencode-sanitizer

[English](README.md) | [中文](README.CN.md)

> 在请求发出去之前，把会踩到服务商审核雷区的字符串换掉。

## 为什么要写它

不是为了防止你上传私钥。是为了不再被那些很「何意味」的敏感词审核恶心到。

事情往往是这样：你正在一个会话里顺畅地干活，忽然某一轮，请求被服务商一巴掌
拍了回来：

```
HTTP 400 Bad Request
```

你翻遍上下文，想破头也找不出哪里违规——也许是个变量名，也许是一行注释，也许是
日志里一个平凡到不能再平凡的单词，也许只是某句再正常不过的话。可服务商的敏感词
系统就是认定它有问题，而且不给你任何解释。

如果只是一次报错倒也罢了。要命的是这段内容已经进了会话历史：下一轮 opencode 原样
重发，审核系统又看到同一个字符串，于是又一个 400；再下一轮，再一个 400。你被死死
钉在原地——不能继续，不能重试，也没法把那条消息单独抠出来删掉。一个小时的上下文，
说没就没，你只能把整个会话扔掉重来。

这种事，一次两次还忍得住，次数多了真的会让人想砸键盘。写这个插件，就是因为被
恶心了太多次。

`opencode-sanitizer` 不评判什么该不该被审，它只做一件事：在 opencode 把上下文真正
打包发往服务商之前，把所有命中你规则的字符串**换成可逆的占位令牌**。审核系统再也
看不到那个刺眼的东西，会话就能平平安安走下去；而当模型把这些令牌原样回吐出来时，
原始字符串会被悄悄还原——所以你本地存下的会话读起来依旧正常。

顺带一提，密钥、token、私钥这类东西当然也能用它一并挡掉——但那只是同一个能力的
附带用法，不是最初的动机。

> 定位说明：它是安全带，不是保险库。它用来自救于"任性"的内容审核和手滑泄露，
> 是一层尽力而为的护栏，而不是严格的安全边界。

## 工作原理

opencode 在拼装一次 LLM 请求前，会依次触发若干"变换钩子"。本插件挂上其中几个：

- `experimental.chat.messages.transform`——逐条消息、逐个 part 地过一遍
  （`text`、`reasoning`、`subtask`、`tool` 状态、`file` 来源），改写其中的文本。
- `experimental.chat.system.transform`——对最终拼好的系统提示词逐项清洗。
- `experimental.text.complete`——在助手正文落盘前，把其中的令牌还原。
- `tool.execute.before`——把工具参数里的令牌还原，让工具拿到真实值而不是占位符。

于是，用户消息、助手正文与推理、工具的输出/输入/元数据、文件片段、系统提示词，
都会在出站那一刻按你的规则洗一遍；而助手正文和工具参数会在回程时反向还原一遍。

`experimental.chat.messages.transform` 拿到的本就是上下文的副本，所以被改动的只有
出站请求——磁盘上的会话仍保留原文。

规则以名称为键写成一张 map，每条规则就是一段普通的 JavaScript 正则（或字面量
字符串）。配置里不再有替换值字段：每个命中项都会被替换成 `<HINT:HASH>`。其中
`HASH` 是命中文本 SHA-256 的前 16 个十六进制字符；`HINT` 默认为
`opencode-sanitizer-identifier-keep-it-as-is`——一句刻意写得冗长、带命令语气的
提示，用来告诉模型「原样保留这个标识符」，降低模型自作主张改写或翻译占位符、
导致无法还原的概率。插件在内存里维护一张 `hash -> 原文` 的表，因此同一段字符串
永远对应同一个令牌，而模型把令牌发回来时也能还原成原文。由于令牌是从命中内容而非
规则推导出来的，正则与字面量规则的行为完全一致；唯一失去的是捕获组替换模板
（`$1`、`$&`）。`g` 标志始终自动补上。插件会在每次变换前检查配置文件的 mtime，只有
变化时才重新解析——所以你可以在会话进行中随时增删规则，无需重启。

由于这张表只活在插件进程的内存里，重启后未还原的令牌就无法恢复了。实际上唯一可能
漏掉、没能还原的地方是助手的 `reasoning` 部分——它不触发任何变换钩子，因此对模型
可读，对你却不是原文。

## 配置

插件会读取两个位置，按名称把两边的规则**合并**生效：

1. `<opencode 工作目录>/opencode-sanitizer.json`（冲突时优先）
2. `$XDG_CONFIG_HOME/opencode-sanitizer/config.json`（未设置 `XDG_CONFIG_HOME` 时为
   `~/.config/opencode-sanitizer/config.json`）

同名的规则以工作目录里的为准，`defaultPlaceholderHint` 也一样。两个文件都不存在
时，规则集为空——插件什么都不改，与没装完全一样。仓库本身也不附带任何默认配置。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/anomalyco/opencode-sanitizer/main/sanitize.schema.json",
  "defaultPlaceholderHint": "opencode-sanitizer-identifier-keep-it-as-is",
  "rules": {
    "false-positive-word": {
      "literal": true,
      "pattern": "敏感词"
    },
    "anthropic-api-key": {
      "pattern": "sk-ant-[A-Za-z0-9_-]{16,}"
    }
  }
}
```

字段说明：

| 字段                           | 含义                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `defaultPlaceholderHint`       | 未单独设置 `placeholderHint` 的规则所用的提示。                |
| `rules`                        | 规则名到规则的 map；键名就是日志里显示的名称。                |
| `rules.<name>.pattern`         | JavaScript 正则源码；`literal` 为 `true` 时按精确字符串处理。 |
| `rules.<name>.flags`           | 正则标志，`g` 始终会被补上。                                   |
| `rules.<name>.literal`         | 把 `pattern` 当字面量，而不是正则。                            |
| `rules.<name>.placeholderHint` | 为该规则覆盖 `defaultPlaceholderHint`。                       |

每个命中项都会被替换成 `<HINT:HASH>`，没有可配置的替换文本。完整 schema 见
`sanitize.schema.json`。

## 安装

### Nix flake（推荐）

flake 暴露：

- `packages.<system>.opencode-sanitizer` 与 `packages.<system>.default`
- `overlays.opencode-sanitizer` 与 `overlays.default`
- `homeModules.opencode-sanitizer` 与 `homeModules.default`

加好 input，导入 home-manager 模块并打开开关即可——模块会自带自己的 package，
你不需要手动接 overlay：

```nix
{
  inputs.opencode-sanitizer.url = "github:anomalyco/opencode-sanitizer";

  # 在你的 home-manager 配置中
  imports = [ inputs.opencode-sanitizer.homeModules.default ];

  services.opencode-sanitizer.enable = true;
}
```

模块会放置两个文件：

- `~/.config/opencode/plugins/opencode-sanitizer.js`——插件本体
- `~/.config/opencode-sanitizer/config.json`——仅当 `settings` 非空时写入

用 `services.opencode-sanitizer.settings` 定义全局规则；项目级的
`opencode-sanitizer.json` 则由你自己放在工作目录里，两者同时生效。`settings`
会在构建时按 `sanitize.schema.json` 校验，配置写错会让 switch 直接失败，而不是
悄悄少掉一条规则。若要替换 package，直接设置
`services.opencode-sanitizer.package` 即可（它只是默认值）。
如果你更愿意自己应用 overlay，`overlays.opencode-sanitizer` / `overlays.default`
仍然可用。

### 手动安装（任意 opencode 环境）

先构建，再让 `opencode.json` 加载插件：

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

规则放在工作目录的 `opencode-sanitizer.json` 里，或者
`~/.config/opencode-sanitizer/config.json` 里。opencode 也能直接加载 TypeScript，
开发时可以指向 `./src/sanitizer.ts`；此外把插件放进 `.opencode/plugins/`（项目级）
或 `~/.config/opencode/plugins/`（全局）也能让 opencode 自动加载。

## 开发

源码在 `src/sanitizer.ts`，用 [rolldown](https://rolldown.rs) 打包到
`dist/sanitizer.js`；依赖由 pnpm 管理：

```sh
pnpm install
pnpm build        # 打包到 dist/
pnpm typecheck    # tsc --noEmit
```

Nix：

```sh
nix flake check
nix build .#default
nix fmt
```
