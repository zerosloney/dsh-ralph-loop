# Changelog

## Unreleased (0.1.0)

首次发布前的完整加固轮。

### ⚠️ Breaking / 行为变化

- peer 依赖对齐 harness `0.1.0-rc.5`（`^0.1.0-rc.5` 同时兼容 rc.6+）。

### Added

- `codegenMaxTokens` 配置（默认 0 = 不设）：Handle 节点代码生成的 maxTokens 硬上限，防单轮生成失控；截断的 JSON 走失败周期自愈。
- 测试套件（node:test，51 用例）：纯函数（JSON 提取/不可变状态/尾部截断/提示词组装）、配置校验、取消与超时语义、沙箱契约（confine/超时/运行器失败规则/路径守卫）、工具输出投影、chat finish 与重试语义、引擎自愈流程（多周期失败→Learn→通过、周期上限耗尽、形状错误自愈、确定性反思、provider/model 回退）。

### Fixed

- **沙箱运行器失败误判为测试失败**：按 seam 契约应用 `confine` 返回的 `runnerFailureRules`（先 `allowedExitCodes` 门控，去除 `informationalLines`，再大小写不敏感匹配 `fatalSignatures`）——运行器在执行命令前失败（bwrap 无法建 namespace 等）现在作为环境错误中止执行，不再作为失败周期把 runner 诊断喂给 LLM 自愈循环空烧配额。
- 沙箱路径守卫逐段校验：嵌套段（如 `sub/con`）命中 Windows 保留设备名或尾点/尾空格同样拒绝，原先只检查整条路径的首段/末段。
- **maxTokens 截断静默**：`chatText` 在 `finish.kind === 'max-tokens'` 时于文本尾部附加截断标记；Handle 的截断 JSON 由 `chatJson` 显式报告"被截断"而非笼统的 "no JSON value"，模型得以区分"缩短输出"与"修格式"两种自愈策略。
- 代码生成结果不含任何 `{path: content}` 形状条目（嵌套值/空对象/非对象顶层）时按解析失败周期处理，不再静默退化为旧文件空跑一轮；codegen 提示词同步携带正/反例（禁止 `{"files": {...}}` 包裹层与嵌套值，值必须为纯字符串），在源头预防这类周期。
- Handle 代码生成的瞬时 LLM 错误此前零重试（与 Plan/Reflect/Learn 不对称），一次网络抖动即烧掉整个失败周期；现在同样退避重试一次，而 max-tokens 截断与解析失败发生在 `chatText` 之外、天然只执行一次（确定性失败重试无意义）。
- 空字符串的 per-call `provider`/`model` 覆盖此前会遮蔽插件配置（`'' ?? config` 不回退），工具模型显式传空串即整个执行报 `no LLM route`；现在与配置 schema 的 `'' = 未设置` 约定一致，空串回退插件配置，两者皆空才报错。
- 工具输出的 `task`/`testCmd` 回显现在与其他字段一致受 8K 截断上限保护（带 originalLength 标记）。
- CI 改用 `npm ci` 按锁定文件可复现安装。
- **LLM 失败静默空转**：harness 的 `ctx.llm.stream()` 对适配器/路由错误不抛异常而是终止性 finish 块——原实现会静默返回空串烧完 `maxCycles`。现在检查 `finish.kind` 并转异常，配错 provider 立刻报错并触发退避重试。
- 沙箱路径守卫扩展：拒绝 Windows 保留设备名（`con`/`nul`/`com1` 等，含带扩展形式）与尾点/尾空格段。
- 修正与 seam 超时契约不符的注释（abort 走 SIGTERM→SIGKILL 升级，`done` 仍 resolve）。
- 文档修正：`ralph/reflect`/`ralph/learn` 载荷并非完整 `RalphState` 快照（是 `{cycle, reflection}` / `{cycle, lesson}`）；README 配置段补 `sandboxDir`；测试数与实际对齐。
