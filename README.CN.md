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

- `experimental.chat.messages.transform`——**深度清洗每条消息**：message info 与所有
  part 里的每个字符串（`text`、`reasoning`、`subtask`、`tool` 状态含 `raw` 与
  `attachments`、`file` 的 filename/source、`patch` 的 files、`agent`、`retry`
  的 error）都会过一遍；只跳过协议标识符，如各类 id、`type`、`role`、`tool`、
  `agent`、`status`、`url`、`mime`。
- `experimental.chat.system.transform`——对最终拼好的系统提示词逐项清洗，并追加一段
  脱敏声明，告诉模型任何 `<HINT:HASH>` 令牌都是不可逆的不透明占位符。
- `experimental.session.compacting`——清洗压缩上下文的 `context` 与 `prompt`。
- `tool.definition`——清洗发给模型的工具 `description`。
- `experimental.text.complete`——在助手正文落盘前，把其中的令牌还原。
- `tool.execute.before`——把工具参数里的令牌还原，让工具拿到真实值而不是占位符。

于是，用户消息、助手正文与推理、工具的输出/输入/元数据、文件片段、工具描述、压缩提示
词、系统提示词，都会在出站那一刻按你的规则洗一遍；而助手正文和工具参数会在回程时反向
还原一遍。

`experimental.chat.messages.transform` 拿到的本就是上下文的副本，所以被改动的只有
出站请求——磁盘上的会话仍保留原文。

规则以名称为键写成一张 map，每条规则就是一段普通的 JavaScript 正则（或字面量
字符串）。配置里不再有替换值字段：每个命中项都会被替换成 `<HINT:HASH>`。其中
`HASH` 是进程内唯一的随机 16 位十六进制 id，**不由命中文本推导**（所以无法用来
反推/确认某个猜测的敏感值）；`HINT` 是一个固定的、不透明、无意义的标识符
（`6f1a3c8e-2b47-4d90-a15f-9c3e7b0d8214`），不可配置。早期设计既允许规则带可读提示、
又用命中内容推导 `HASH`，两个想法都适得其反：模型（尤其是推理模型）会盯着提示试图
还原原文——以 DeepSeek 为例，流式思考里一旦出现敏感词，它会直接中断流；而内容推导的
hash 还会泄露「某个猜测值是否被脱敏」。去掉语义抓手，再配合插件注入系统提示词的脱敏
声明（「原样复制、不要去解码」），模型就不会去尝试还原了。插件在内存里维护
`id -> 原文` 与 `原文 -> id` 两张表，因此同一段字符串在**同一进程内**对应同一个令牌，
模型把令牌发回来时也能还原成原文。插件自己发出的每一个令牌都会被当作不透明内容、
不再被任何规则改写，所以匹配 UUID、十六进制串或尖括号的规则都无法破坏令牌，清洗也
保持幂等。正则与字面量规则的行为完全一致；唯一失去的是
捕获组替换模板（`$1`、`$&`）。`g` 标志始终自动补上。插件会在每次变换前检查配置文件的
mtime，只有变化时才重新解析——所以你可以在会话进行中随时增删规则，无需重启。

由于这张表只活在插件进程的内存里，重启后未还原的令牌就无法恢复了。实际上唯一可能
漏掉、没能还原的地方是助手的 `reasoning` 部分——它不触发任何变换钩子，因此对模型
可读，对你却不是原文。

## 配置

插件会读取两个位置，两边的规则**全部参与匹配**：

1. `$XDG_CONFIG_HOME/opencode-sanitizer/config.json`（未设置 `XDG_CONFIG_HOME` 时为
   `~/.config/opencode-sanitizer/config.json`）——全局配置
2. `<opencode 工作目录>/opencode-sanitizer.json`——项目配置

规则名只是日志里的标签，不再用作覆盖或去重依据；同名规则会各自独立参与匹配。**每一条规则
的每一次命中都会被脱敏，没有任何例外**：两条命中重叠时，它们会被合并成一个覆盖其并集的
令牌，因此命中范围内的任何字符都不会残留——连「落选」那条的碎片也不会。互不重叠的命中则
各自是独立的令牌。旧版的先后顺序与「宽度/优先级取胜」裁决已经删除，因为那会留下落选匹配
的碎片。两个文件都不存在时，规则集为空——插件什么都不改，与没装完全一样。仓库本身也不
附带任何默认配置。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/lialh4qwq/opencode-sanitizer/main/sanitize.schema.json",
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

| 字段                   | 含义                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `rules`                | 规则名到规则的 map；键名就是日志里显示的名称。                |
| `rules.<name>.pattern` | JavaScript 正则源码；`literal` 为 `true` 时按精确字符串处理。 |
| `rules.<name>.flags`   | 正则标志，`g` 始终会被补上。                                   |
| `rules.<name>.literal` | 把 `pattern` 当字面量，而不是正则。                            |

每个命中项都会被替换成 `<HINT:HASH>`，其中 `HINT` 为固定的不透明标识符，没有可配置
的替换文本或提示。完整 schema 见
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
  inputs.opencode-sanitizer.url = "github:lialh4qwq/opencode-sanitizer";

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
`dist/sanitizer.js`；依赖由 pnpm 管理。测试在 `test/`，跑在 Node 自带的测试运行器上
（直接引入 TypeScript 源码，无需先构建）：

```sh
pnpm install
pnpm build        # 打包到 dist/
pnpm typecheck    # tsc --noEmit
pnpm test         # node --test test/
```

Nix：

```sh
nix flake check
nix build .#default
nix fmt
```
