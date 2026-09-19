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
打包发往服务商之前，把所有命中你规则的字符串**就地替换**掉。审核系统再也看不到那个
刺眼的东西，会话就能平平安安走下去。

顺带一提，密钥、token、私钥这类东西当然也能用它一并挡掉——但那只是同一个能力的
附带用法，不是最初的动机。

> 定位说明：它是安全带，不是保险库。它用来自救于"任性"的内容审核和手滑泄露，
> 是一层尽力而为的护栏，而不是严格的安全边界。

## 工作原理

opencode 在拼装一次 LLM 请求前，会依次触发若干"变换钩子"。本插件挂上其中两个：

- `experimental.chat.messages.transform`——逐条消息、逐个 part 地过一遍
  （`text`、`reasoning`、`subtask`、`tool` 状态、`file` 来源），改写其中的文本。
- `experimental.chat.system.transform`——对最终拼好的系统提示词逐项清洗。

于是，用户消息、助手正文与推理、工具的输出/输入/元数据、文件片段、系统提示词，
都会在出站那一刻按你的规则洗一遍。

每条规则就是一段普通的 JavaScript 正则（或字面量字符串）加一个替换值；`g` 标志
始终自动补上。插件会在每次变换前检查配置文件的 mtime，只有变化时才重新解析——
所以你可以在会话进行中随时增删规则，无需重启。

## 配置

插件会同时读取两个位置，把两边的规则**合并**在一起生效，二者没有先后、没有覆盖：

1. `<opencode 工作目录>/opencode-sanitizer.json`
2. `$XDG_CONFIG_HOME/opencode-sanitizer/config.json`（未设置 `XDG_CONFIG_HOME` 时为
   `~/.config/opencode-sanitizer/config.json`）

两个文件都不存在时，规则集为空——插件什么都不改，与没装完全一样。仓库本身也不
附带任何默认配置。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/anomalyco/opencode-sanitizer/main/sanitize.schema.json",
  "rules": [
    {
      "name": "false-positive-word",
      "literal": true,
      "pattern": "敏感词",
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

字段说明：

| 字段          | 含义                                                           |
| ------------- | -------------------------------------------------------------- |
| `name`        | 便于日志辨认的可读名称。                                       |
| `pattern`     | JavaScript 正则源码；`literal` 为 `true` 时按精确字符串处理。 |
| `flags`       | 正则标志，`g` 始终会被补上。                                   |
| `replacement` | 替换文本，支持 `$1`、`$2`、`$&`、`$$`，默认为空字符串。       |
| `literal`     | 把 `pattern` 当字面量，而不是正则。                            |

完整 schema 见 `sanitize.schema.json`。

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
`opencode-sanitizer.json` 则由你自己放在工作目录里，两者同时生效。若要替换
package，直接设置 `services.opencode-sanitizer.package` 即可（它只是默认值）。
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
