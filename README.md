# 座舱 Agent 模拟环境 · v0.1

主 Agent 已可用：接真实大模型，理解自然语言，调用车内能力，处理约束、拒绝与二次确认。

## 跑起来

```bash
npm install
npm run dev          # 打开 http://localhost:5173
```

1. 在控制面板顶部填入 **OpenRouter API Key**
2. 模型列表会自动拉取（只保留支持 function calling 的），默认勾选「只看快速模型」并按价格升序
3. 点右上角 **打开车机屏** → 拖到外接屏 → 按 **F** 全屏
4. 在「对话」框里直接说话，或点 Golden Case 逐条验证

```bash
npm test             # 77 个测试
npm run build        # 静态产物，dist/ 双击即可打开
```

> **Key 不入库**：放在 `.env.local`（已 gitignore）或直接在控制面板里填。

## 结构

```
config/  → src/config/*.ts   信号 · 约束 · Tool 定义（加能力 = 加数据）
src/core/     State Store · 约束引擎 · 过渡仿真 · 不变量断言
src/tools/    注册表 · 能力授权 · 统一返回契约 · MRTR 确认流
src/agent/    Runtime · 上下文注入 · 并行编排 · OpenRouter 适配
src/screen/   车机屏（纯净，可投屏）
src/director/ 控制面板（状态调节 · Golden Case · 全链路追踪）
agents/main-agent/  manifest + 人设（19 行）
```

## 已实现的设计约束

| 约束 | 状态 |
|---|---|
| 零后端、零运行时依赖 | ✅ 只有 vite / vitest / typescript 三个 devDependency |
| 加信号 / 加约束 / 加 Tool = 改数据不改代码 | ✅ 7 个 Tool 中 5 个零 handler 代码 |
| 代码零意图分支 | ✅ 全部意图理解在 Prompt 里 |
| 信号必带 vssPath（VSS v6.0） | ✅ 构建期由测试强制 |
| AAOS 三元组 Access / ChangeMode / Permission | ✅ |
| 权限「黑 / 灰 / 彩」，黑级永不暴露给模型 | ✅ |
| 二次确认对齐 MCP MRTR `inputRequired` | ✅ token 一次性、60s 过期、与 Tool 名绑定 |
| 批量操作不做部分写入 | ✅ 先全量试算再提交 |

## 代码规模 vs 预算

| 模块 | 实际 | 预算 |
|---|---|---|
| core | 190 | < 800 |
| tools | 153 | < 600 |
| agent | 238 | < 500 |

## 尚未实现（下一步）

- 卡片系统完整生命周期：ttl / priority / 抢占 / Agent 区满载降尺寸（当前车机屏只有静态栅格与简易 Agent 区卡位）
- Golden Case 10~13（卡片编排类）
- 主动式触发、长期记忆
- vssPath 逐条核验（当前为待验证的推定路径，见 `src/config/signals.ts` 顶部注释）
