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
| 每次执行独立的隔离临时工作目录（沙箱纯净度） | 沙箱适配（`ctx.subprocess` + `node:fs`） |

## 设计要点（与设计文档的适配）

- 文档伪代码中的 `ctx.llm.chat(...)` 落地为 harness 原生 `ctx.llm.stream(GenerateOptions)` + 权威 `BlockAssembler`；Handle 的 JSON 生成经 `chatJson` + 容错 `extractJson`（去围栏/平衡括号提取）。
- **LLM 失败显式化**：harness 语义下适配器/路由错误（provider 未注册、限流、网络失败）不抛异常，而是以终止性 finish 块结束流——`chatText` 迭代后检查 `finish.kind`，`error`/`aborted` 转为异常上抛。配错 provider 会立刻报错并触发退避重试，而不是静默返回空串、把 `maxCycles` 个周期空烧完。
- harness 没有 `ctx.sandbox` 服务：文档的 `sandbox.writeFile/runBash` 映射为隔离临时目录内的 `node:fs` 写入 + `ctx.subprocess.spawn`（collect 模式、树级终止、abort 超时）。路径守卫拒绝绝对路径、`..` 穿越、Windows 保留设备名（`con`/`nul`/`com1` 等，含带扩展形式）与尾点/尾空格段。
- **沙箱是工作目录纯净度隔离，非安全边界**：`testCmd` 是任意 shell 命令、LLM 可经其任意执行，符号链接可绕过路径守卫——不用于隔离不可信输入。
- 门禁唯一客观判据：退出码 `0`。测试命令超时（`testTimeoutMs`）按退出码 `-1` 走失败循环。
- Plan/Reflect 的提示词同时携带上次执行的 **stdout 与 stderr**（各尾部截断约 4KB——pytest/jest/go test 的失败摘要在 stdout 末尾），失败根因对反思节点完整可见。
- 代码生成 JSON 解析失败不抛错：作为一次失败循环（stderr 记录 `RALPH 方案解析失败`）进入 Reflect/Learn，下一轮自愈。
- 超过 `maxCycles` 硬上限自动终止，返回带累积 `lessonsLearned` 的最终快照（`isPassed: false`）。`maxCycles` 在工具 schema 与引擎双重钳制在 1-20，防误调用烧配额。
- 整个闭环有总预算（`totalTimeoutMs`，默认 30 分钟；`execute` 可经 `deadlineMs` 覆盖）：到点优雅终止，最终快照带 `timedOut: true`，防止 llm.stream 挂起把工具调用钉死。
- `autoReflectOnFailure: false` 时失败反思退化为确定性 stderr 片段，零模型调用。

## 安装

```sh
# 发布后
dsh plugin --profile web add dsh-ralph-loop

# 本地开发（file: 链接）
# 在 $DSH_HOME/profiles/<name>/package.json 加依赖并安装
```

profile 的 `dsh.profile.bundles` 需要包含 `dsh-ralph-loop`；插件依赖 harness 的 `llm` / `tools` / `subprocess` 服务（base bundle 提供）。

## 工具（`ctx.tools`）

| 工具 | 作用 |
| --- | --- |
| `run_ralph_loop` | 在隔离沙箱中跑一轮 RALPH 闭环：`task` / `test_cmd` 必填，`files` / `max_cycles` / `provider` / `model` 可选。返回最终状态：验证通过的 `files`、测试输出、反思、累积负向约束。 |

## 事件（`ctx.emit`）

`ralph/start`、`ralph/cycle-start`、`ralph/reflect`、`ralph/learn`、`ralph/success`、`ralph/cycle-end`、`ralph/end`。全部载荷为不可变 `RalphState` 快照，可直接对接 dsh Trajectory 回放。

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
        totalTimeoutMs: 1800000 # 整个闭环的总 wall-clock 预算（默认 30 分钟）
```

## 开发

```sh
npm install
npm run build        # tsc → lib/
npm run typecheck
npm test             # build + node --test（pure.ts 解析/状态/提示词，8 用例）
```

引擎为纯函数 + 注入式服务 seam：`engine.ts` / `pure.ts` 可在无 harness 环境下用假 llm/subprocess 直测（状态流转、事件序列、熔断、解析自愈）。

## 许可

MIT。
