# dsh-ralph-loop

RALPH 认知闭环插件：把 **Reflect（反思）→ Assess（评估）→ Learn（学习）→ Plan（规划）→ Handle（执行）** 的五阶段状态机接入 DeepSeek Harness (dsh)。针对传统 ReAct 循环的盲目试错、错误震荡与缺乏经验沉淀问题，提供确定性、可自愈的自主代码生成与错误修复闭环。

```text
Plan ➔ Handle（写文件 + 跑测试）➔ Reflect（根因分析）➔ Assess（退出码门禁）➔ Learn（负向约束沉淀）
```

## 这是什么

`dsh-ralph-loop` 是一个 **dsh bundle 包**，导出单个 cordis 插件：

| 能力 | 落点 |
| --- | --- |
| `ctx.ralph` 服务：`execute(task, testCmd, initialFiles)` 一键闭环 | 服务注册（`RalphService`） |
| 五阶段状态机 + 不可变状态快照 + `maxCycles` 硬上限 | 状态引擎（`engine.ts`） |
| `run_ralph_loop` 工具，LLM 可自主触发子图自愈 | `ctx.tools` |
| `ralph/*` 生命周期事件（start / cycle-start / reflect / learn / success / cycle-end / end） | `ctx.emit` 事件总线 |
| 每次执行独立的临时工作目录；测试 shell 通过 Harness Sandbox 约束 | 沙箱适配（`ctx.sandbox.confine` + `ctx.subprocess` + `node:fs`） |

## 设计要点（与设计文档的适配）

- 文档伪代码中的 `ctx.llm.chat(...)` 落地为 harness 原生 `ctx.llm.stream(GenerateOptions)` + 权威 `BlockAssembler`；Handle 的 JSON 生成经 `chatJson` + 容错 `extractJson`（去围栏/平衡括号提取）。
- **LLM 失败显式化**：harness 语义下适配器/路由错误（provider 未注册、限流、网络失败）不抛异常，而是以终止性 finish 块结束流——`chatText` 迭代后检查 `finish.kind`，`error`/`aborted` 转为异常上抛。配错 provider 会立刻报错并触发退避重试，而不是静默返回空串、把 `maxCycles` 个周期空烧完。
- 测试命令先构造当前平台的精确 shell argv，经 `ctx.sandbox.confine(argv, { mode: "workspace-write", workspaceRoot: <本次临时目录> })` 获得受限 argv，再交给 `ctx.subprocess.spawn`（collect 模式、树级终止、abort 超时）。Sandbox 缺失或不可用时 fail-closed，绝不回退到原始命令；插件自身仍使用 `node:fs` 准备/清理临时目录并执行路径守卫。
- **Sandbox 边界**：`ctx.sandbox` 主要约束测试进程的文件效果，不等于网络、凭据或全系统隔离；Windows 或其他后端可能报告 `partial`。`confined.enforcement` 不是 `full`（包括 `partial`）时默认 fail-closed，不执行测试命令，也不裸回退到原始 argv。沙箱运行器在执行命令前失败按 seam 的 `runnerFailureRules`（`allowedExitCodes` 门控 → 去除 `informationalLines` → 大小写不敏感匹配 `fatalSignatures`）识别为环境错误并中止执行，不作为测试失败进入自愈循环。`testCmd` 仍是任意 shell 命令，只应在受控任务和受信任的 Harness profile 中使用。
- 门禁唯一客观判据：退出码 `0`。测试命令超时（`testTimeoutMs`）按退出码 `-1` 走失败循环。
- Plan/Reflect 的提示词同时携带上次执行的 **stdout 与 stderr**（各尾部截断约 4KB——pytest/jest/go test 的失败摘要在 stdout 末尾），失败根因对反思节点完整可见。
- 代码生成 JSON 解析失败不抛错：作为一次失败循环（stderr 记录 `RALPH 方案解析失败`）进入 Reflect/Learn，下一轮自愈。生成结果不含任何 `{path: content}` 形状条目（嵌套值/空对象/非对象顶层）时同样按解析失败处理，不会静默用旧文件空跑一轮；codegen 提示词携带正/反例显式禁止 `{"files": {...}}` 包裹结构与嵌套值，预防这类周期；`maxTokens` 截断在失败原因中显式报告、并在生成文本尾部携带截断标记，与格式错误区分开。
- 超过 `maxCycles` 硬上限自动终止，返回带累积 `lessonsLearned` 的最终快照（`isPassed: false`）。`maxCycles` 在工具 schema 与引擎双重钳制在 1-20，防误调用烧配额。
- 整个闭环有总预算（`totalTimeoutMs`，默认 30 分钟；`execute` 可经 `deadlineMs` 覆盖）：预算通过内部 `AbortSignal` 主动中止正在进行的 `llm.stream` 与测试 subprocess（实际停止仍取决于适配器遵守取消信号），并返回带 `timedOut: true` 的最终快照、正常发出一次 `ralph/end`，防止挂起调用把工具调用钉死。外层 tool caller 自己 abort 时保留调用方原始取消 reason 并直接取消，不发正常 `ralph/end`。
- `autoReflectOnFailure: false` 时失败反思退化为确定性 stderr 片段，零模型调用。

## 安装

插件已发布到 npm registry（`dsh-ralph-loop`，随 `v*` tag 由 CI 自动发布）。在 DeepSeek Harness 中通过 npm 包路径安装——`dsh plugin add` 会安装依赖并自动把包名追加到 profile 的 `dsh.profile.bundles`：

```sh
dsh plugin add --profile web dsh-ralph-loop
dsh --profile web --dump-config          # 确认 ralph-loop 行已组合
```

profile 的 `dsh.profile.bundles` 需要包含 `dsh-ralph-loop`；插件依赖 Harness 的 `llm` / `tools` / `subprocess` / `sandbox` 服务（通常由 base bundle 提供）。宿主 profile 必须挂载可用的 Sandbox provider；`dsh-ralph-loop` 不自带 `dsh-sandbox-local`。升级到新版本：`dsh plugin add --profile web dsh-ralph-loop@latest`。

## 工具（`ctx.tools`）

| 工具 | 作用 |
| --- | --- |
| `run_ralph_loop` | 在隔离沙箱中跑一轮 RALPH 闭环：`task` / `test_cmd` 必填，`files` / `max_cycles` / `provider` / `model` 可选。返回最终状态：验证通过的 `files`、测试输出、反思、累积负向约束。 |

## 事件（`ctx.emit`）

`ralph/start`、`ralph/cycle-start`、`ralph/success`、`ralph/cycle-end`、`ralph/end` 的载荷为不可变 `RalphState` 快照，可直接对接 dsh Trajectory 回放；`ralph/reflect` 与 `ralph/learn` 为轻量载荷 `{ cycle, reflection }` / `{ cycle, lesson }`。

## 配置（`cordis.patch.yml` 的 `config`）

```yaml
- insert:
    - id: ralph-loop
      name: 'dsh-ralph-loop'
      config:
        maxCycles: 5            # 硬循环上限（工具调用可覆盖，钳制在 1-20）
        autoReflectOnFailure: true  # false = 确定性 stderr 反思
        verboseLogging: false   # 逐阶段日志
        provider: ''            # LLM provider（执行时必填，工具调用可覆盖）
        model: ''               # LLM model（执行时必填，工具调用可覆盖）
        codegenMaxTokens: 0     # Handle 代码生成的 maxTokens 硬上限；0 = 不设
        testTimeoutMs: 120000   # 单次测试命令超时
        sandboxDir: ''          # 沙箱临时目录基址；缺省 = 每次执行独立的 OS 临时目录
        totalTimeoutMs: 1800000 # 整个闭环的总 wall-clock 预算（默认 30 分钟）
```

## 开发

```sh
npm install
npm run build        # tsc → lib/
npm run typecheck
npm test             # build + node --test（51 用例：纯函数 / 配置校验 / 取消与超时 / 沙箱契约 / 工具投影 / 引擎自愈 / chat 语义）
```

引擎为纯函数 + 注入式服务 seam：`engine.ts` / `pure.ts` 可在无 harness 环境下用假 llm/subprocess 直测（状态流转、事件序列、熔断、解析自愈）。

## 许可

MIT。
