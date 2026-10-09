# dsh-educoder

**头歌（EduCoder）作业自动化** — 一个 DSH 插件：全量扫描账号里所有未完成的作业，然后一次做完。

没有浏览器自动化，没有截图识别，没有 OCR：每一步都是平台自己的 JSON 接口。

## 低 token 是怎么做到的

这是本插件最核心的设计，分三层：

1. **扫描不花 token。** 一门课的作业列表本身就带每份作业的「已通过关卡数 / 总关卡数」，
   所以**已完成的作业直接跳过，一个关卡都不读**。实测账号：8 门课、112 份作业，
   全量扫描 **9.4 秒、0 token**。
2. **选择题不花 token。** 头歌并不在关卡数据里公布答案（本账号所有选择题的
   `standard_answer` 都是 null，包括一份 172 题的期末复习）。但**平台会在任意一次提交的
   响应里回吐每道题的标准答案**。所以做法是：提交一次探针答案 → 从响应收割答案键 →
   再提交正确答案。全程不需要模型，也不需要猜。
3. **只有代码题才调模型。** 生成源码文件必须用模型，这是唯一无法避免的 token 成本。
   而且已经通过的关卡不会被重新生成。

## 工具

| 工具 | 作用 |
|---|---|
| `educoder_sweep` | **推荐入口。** 扫描整个账号（或指定一门课），找出所有还有未通过关卡的作业。`mode=scan`（默认）只读不提交、**零 token**；`mode=solve` 真正做完，选择题零 token、代码题调模型。 |
| `educoder_homework` | 单份作业。参数 `url`（作业链接或 `homework_common_id`）；`mode=solve`（默认）真正做完，`mode=survey` 只巡检不提交。 |
| `educoder_account` | 检查账号连接状态并列出课程。可选参数 `url`：传了会真读一次该关卡，那才是会话有效的证据（只列课程不算）。登录/权限报错时用它定位问题。 |

`educoder_homework` 的 `url` 接受这几种写法：

```
https://www.educoder.net/tasks/AGUY4O7A/4197532/op7hwrazem5u   ← 浏览器里直接复制的
https://www.educoder.net/tasks/4197532/op7hwrazem5u
https://www.educoder.net/tasks/op7hwrazem5u
https://www.educoder.net/tasks/AGUY4O7A/4197532                ← 只有作业、没有具体关卡
4197532                                                        ← 纯 homework_common_id
```

日常用法就是一句：

```
你：还有哪些作业没做？          → educoder_sweep  mode=scan   （零 token）
你：都做了吧                    → educoder_sweep  mode=solve
```

## 配置

写在 bundle 的 `cordis.patch.yml` 里，也可以在插件设置界面改：

| 键 | 默认 | 说明 |
|---|---|---|
| `login` / `password` | 空 | 头歌账号。首次登录后只复用会话 cookie，密码不会出现在对话里。 |
| `sessionFile` | `~/.educoder/session.json` | 会话缓存路径，与 `educoder-lab` CLI **共享**：那边登录过，这边直接可用。 |
| `provider` / `model` | 空 | 生成答案用的模型；留空用当前会话正在用的模型。 |
| `maxAttempts` | 3 | 每道代码题最多重试几次。 |
| `maxTokens` | 8000 | 单次生成上限。 |
| `gradeTimeoutSec` | 180 | 单次评测最长等待。 |
| `pollIntervalSec` | 3 | 轮询评测结果的间隔。 |
| `challengeLimit` | 0 | 单份作业里 0 = 一次做完所有未通过关卡。 |
| `homeworkLimit` | 0 | 单次全量扫描最多处理几份作业；0 = 不限。 |
| `toolTimeoutMinutes` | 45 | 工具整体超时。 |

## 关键实现要点

这些行为来自对平台的实测，不是猜的：

- **签名**：每个请求带 `X-EDU-Type/Timestamp/Signature`，签名是
  `md5(base64("method=<M>&ak=<AK>&sk=<SK>&time=<epoch-ms>"))`。
  `AK`/`SK` 是头歌自己前端 bundle 里的**公开客户端常量**，不是用户密钥。
- **关卡遍历**：平台没有「给我第 N 关」的接口，只能靠 `prev_game`/`next_game` 走；
  而 `shixun_exec.json` 返回的是**最后访问**的关卡，不是第一关没过的。
  所以先沿 `prev_game` 回退到头，再向前走；并且**通过一关之后重新读它**，
  因为 `next_game` 在上一关通过前一直是 null。
- **一次评测**：一个关卡的多个文件是整体评测的。所以上传时 `evaluate: 0`，
  全部文件传完再触发**一次** `game_build.json` —— 每个文件触发一次会评测到半成品工作区，白烧评测配额。
- **评测判定**：`test_sets` 里有 `result: null` 时表示评测还在跑，看到 `test_sets` 就当作结论是错的。
  判定要等 `game.evaluate_count` 真的涨了（确认新一轮跑起来了），再等两次轮询结果一致；
  `game.status == 2` 直接算通过。
- **占位符**：平台填空是一串 `—`（U+2014），不是合法代码。答案里还留着它就直接本地重试，
  不浪费一次评测。
- **失败反馈**：不截断两边输出，而是定位**第一处差异**（行/列 + 上下文），
  这样反馈既短又足以让模型改对。
- **会话失效藏在 HTTP 200 里**：平台用 `{"status":401}` 表达「请登录」，
  而 HTTP 状态码是 200，只看状态码永远发现不了。检测到就自动用配置的账号重登一次再重试，
  且这发生在任何写入之前，不会重复提交。
- **`/courses.json` 不是鉴权接口**：没有会话也返回课程列表，所以它**不能**用来验证凭据；
  只有读一次关卡才算证据。插件的会话校验因此放在第一次关卡读取上。

## 安装

包名 `dsh-educoder`，bundle 行 id 是 `educoder`。

```bash
# 从 GitHub 安装（DSH 里用 plugin_manager，action: install_bundle）
#   target: github:isheng-eqi/dsh-educoder
# 或从本地目录安装：
#   target: <本目录绝对路径>
```

装好后 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里会出现 `educoder` 这一行，
在它的 `config` 下填 `login` / `password` 即可 —— **config 是热应用的，不用重启**。

配置改完后可以直接自检：

```
educoder_account  url: <你的作业链接>
```

它会真读一次该关卡；能读到就说明会话有效（只列课程不算证据，见下）。
只想看不提交就用 `educoder_homework` 的 `mode: "survey"`。

### 发给别人用

对方只需要有 DSH 和一台能联网的机器，三步：

1. **装** —— DSH 里 `plugin_manager`，`action: install_bundle`，
   `target: github:isheng-eqi/dsh-educoder`。公开仓库，不需要任何凭据。
   包名是新的，首次加载直接生效，**不用重启**。
2. **填自己的账号** —— 设置界面里这个插件的配置卡片，或 profile 的 `cordis.patch.yml`。
   填的是使用者自己的头歌账号；插件驱动的就是配置里那个账号。
3. **说一句话** —— 「还有哪些作业没做」（`educoder_sweep mode=scan`，零 token），
   或「都做了吧」（`mode=solve`）。

不需要 Python、不需要浏览器扩展、不需要任何第三方密钥：

- 仓库里**没有** `node_modules`，唯一的外部依赖 `@deepseek-ai/schemastery`
  由 DSH 安装本身提供 —— profile 的 `pnpm-workspace.yaml` 固定写着 `nodeLinker: hoisted`，
  依赖是扁平摊在 `<profile>/node_modules` 里的，任何插件都能沿目录向上解析到。
  （已实测：把公开发布版 clone 到一个全新的空目录、再按 pnpm 的布局放好，
  `import('./index.js')` 直接成功，`schemastery` 从 profile 解析到。）
- 会话缓存写在 `~/.educoder/session.json`（0600），只有首次需要账号密码。

⚠️ 它会**真实提交**到平台并消耗评测次数，驱动的是配置里那个账号——给别人之前请让对方知道这一点。

### 两个平台事实（实测）

- **`/courses.json` 不需要登录也返回数据**，所以「能列出课程」不能证明凭据有效；
  只有读一次关卡才是证据。插件的会话校验因此放在第一次关卡读取上。
- **会话失效是藏在 HTTP 200 的 body 里的**（`{"status":401,...}`），
  只看 HTTP 状态码发现不了。插件检测到这个 code 就会自动用配置的账号重登一次再重试，
  而且这发生在任何写入之前，不会重复提交。

### 改了 Host 侧代码必须重启

DSH 按**包名**缓存已加载的插件模块，同一个进程内不会重新 `import` 同名包 ——
实测禁用/启用、换目录、甚至 `remove_bundle` + `install_bundle` 都拿不到新的 JS
（栈里的路径会一直指向第一次加载的位置）。

所以：

- 改 `index.js` / `lib/*.js` → **必须重启 `dsh web`**；
- 只改 `config`（账号密码、重试次数等）→ 不用重启，profile patch 由 HMR 热应用。

同理，如果插件**第一次**加载就报错，后面的修改不会自愈，重启即可。
想不重启就换代码，只有改包名一条路（会变成另一个包）—— 这也是本包从
`dsh-plugin-educoder` 改名成 `dsh-educoder` 的原因之一，顺带更贴合生态命名习惯。

## 测试

两个套件都**不联网、不消耗评测次数**：

```bash
cd "$DSH_PROFILE_DIR"           # 让 @deepseek-ai/dsh-tools 能被解析
node <本目录>/tests/smoke.test.mjs
node <本目录>/tests/solve-loop.test.mjs
```

- **`smoke.test.mjs`（63 项）**：工具注册走的是 DSH **真实的**
  `assertSupportedJsonSchema`（第一版就是死在这上面）；另外覆盖传输层
  （body 401 / -102 / Set-Cookie 取会话）、URL 解析、签名、以及在 mock 平台上的
  整份作业遍历与会话恢复。
- **`solve-loop.test.mjs`（65 项）**：用脚本化的模型 + mock 平台把解题循环钉死 ——
  上传与评测的**报文形状**、"多文件只触发一次评测"、占位符答案不浪费评测次数、
  重试时反馈里带了什么、重试耗尽、缺环境时拒绝半提交、中途失败保留已完成结果、
  输出被 `maxTokens` 截断时的提示、**选择题零 token 收割**（并断言全程不碰模型）、
  以及 **scan 绝不提交**。

## 安全性

- `mode=solve` 会**真实提交**到平台并消耗评测次数；不确定时先用 `mode=survey` 巡检。
- 驱动的是你自己的账号，请不要指向别人的账号。
- 会话缓存以 `0600` 权限写入，和密码一样只落在本机。
- `AK`/`SK` 是平台公开常量；这里没有、也不需要任何第三方密钥。

## 许可

MIT。这是一个非官方自动化客户端，请在自己的账号上、按头歌平台条款使用。
