# Changelog

## Unreleased (0.1.0)

首次发布前的完整加固轮。

### ⚠️ Breaking / 行为变化

- peer 依赖对齐 harness `0.1.0-rc.5`（`^0.1.0-rc.5` 同时兼容 rc.6+）。

### Added

- `codegenMaxTokens` 配置（默认 0 = 不设）：Handle 节点代码生成的 maxTokens 硬上限，防单轮生成失控；截断的 JSON 走失败周期自愈。
- 测试套件（node:test，8 用例）：JSON 提取/不可变状态/尾部截断/确定性反思/提示词组装。

### Fixed

- **LLM 失败静默空转**：harness 的 `ctx.llm.stream()` 对适配器/路由错误不抛异常而是终止性 finish 块——原实现会静默返回空串烧完 `maxCycles`。现在检查 `finish.kind` 并转异常，配错 provider 立刻报错并触发退避重试。
- 沙箱路径守卫扩展：拒绝 Windows 保留设备名（`con`/`nul`/`com1` 等，含带扩展形式）与尾点/尾空格段。
- 修正与 seam 超时契约不符的注释（abort 走 SIGTERM→SIGKILL 升级，`done` 仍 resolve）。
