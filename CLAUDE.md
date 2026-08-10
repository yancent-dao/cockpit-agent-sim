# 座舱 Agent 模拟环境

给座舱产品经理做 AI Demo 用的公共底座。目标不是做一个产品，是让每次做 Demo 不用从零开始。

完整需求见 `docs/需求规格说明书_v1.0.md`，工程约束见 `docs/工程约束_v1.1.md`。**这两份是唯一事实来源，改设计前先读。**

## 命令

- 测试：`npm test`（当前 132 个，必须全绿才算完成）
- 监视：`npm run test:watch`
- 开发：`npm run dev` → http://localhost:5173
- 构建：`npm run build`
- 类型检查：`npx tsc --noEmit`
- 单文件版（无需 npm，可直接双击）：`node build-single.mjs` → `single/`

## 开发方式：TDD，不许跳过

1. 先写测试，跑，看它**红**
2. 再写实现，跑，看它**绿**
3. 重构

已经有两次真实 bug 是被测试抓到的（批量写入的部分提交、`'*'` 通配跨段不匹配），不要因为"这段很简单"就跳过红阶段。

测试文件与源码同构：`tests/<模块>/<文件>.test.ts`。

## 五条核心原则（改任何东西前先对照）

1. **Tools = 机制，Agent = 策略。** Tool 内不写任何"贴心逻辑"。`climate.set` 绝不因为外面冷就自己多加两度。
2. **平台不认识任何具体 Agent。** Agent 靠 `agents/*/manifest.ts` 注册。验收标准：新建一个只挂 3 个 Tool 的 agent，不改平台一行代码就能跑。
3. **不发明命名，不发明协议。** 信号对齐 COVESA VSS v6.0，元数据对齐 AAOS 三元组，确认流对齐 MCP MRTR。
4. **拒绝必须携带机器可读原因。** `{code, message, suggestion}`，`message` 写人话不写日志——它会直接进模型上下文。
5. **无APP化下「该执行什么」和「该显示什么」是两类决策**，分开建模。

## 四条硬约束（违反视为设计失败）

- **零后端。** 产物是静态文件。不要引入服务端、数据库、Docker。
- **加能力 = 加数据，不加代码。** 新增信号/约束/Tool 只改 `src/config/*.ts`。如果需要动 `src/core/`，说明抽象错了。
- **代码里不许出现意图分支。** 出现 `if (intent === ...)`、关键词匹配、意图枚举即违规。Agent 表现不好就改 Prompt 或改 Tool 描述，**不要在代码里兜底**——兜了就分不清是模型聪明还是代码作弊。
- **运行时依赖为零。** 只有 vite / vitest / typescript 三个 devDependency。加新依赖前先问："不加它要多写多少行？"少于 200 行就自己写。

## 结构与规模预算

```
src/config/    signals · constraints · tools · cards —— 数据，越多越好
src/core/      State Store · 约束引擎 · 过渡仿真 · 不变量断言    < 800 行（现 195）
src/tools/     注册表 · 能力授权 · 返回契约 · MRTR 确认流        < 600 行（现 204）
src/cards/     卡片桌面 · 栅格 · 分区 · 生命周期 · 抢占          < 700 行（现 265）
src/agent/     Runtime · 上下文注入 · 并行编排 · OpenRouter      < 500 行（现 251）
src/screen/    车机屏（纯净可投屏）      ← 不许有业务逻辑
src/director/  控制面板（调试/演示）      ← 不许有业务逻辑
agents/        Agent 实例：manifest + 人设
```

超预算时不要提高预算，先检查是不是有逻辑漏进了 UI 层。

## 复杂度的三个落点，各有上限

- **约束引擎**：只支持 `[path, op, value]` 三元组，不支持嵌套逻辑。复杂场景写具名谓词函数登记白名单。**绝不引入 eval 或表达式引擎。**
- **卡片布局**：因为每个尺寸只允许一种形状，退化为一维排布。**不追求最优解，追求可预测解**——演示者能预判结果比空间利用率重要。
- **Agent 编排**：全部在 Prompt 里。代码只做四件事：上下文拼装、并行调用、结果回填、确认流转。

## 权限分级：黑 / 灰 / 彩

- **彩** auto，可直接执行
- **灰** confirm，需二次确认（判据：不可逆 / 涉及安全 / 涉及金钱 / 涉及他人）
- **黑** 永久禁区，**永不注册给 Agent**（刹车、转向）

注意区分「黑」（Tool 根本不存在）和 `rejected`（Tool 存在但本次条件不满足）——早期版本混淆过这两个。

## 明确不做

后端 · 数据库 · 多屏 · 日间模式 · 完整设计系统 · Tool 路由（14 个直接全量挂载）· CAN 时延与报文级仿真 · monorepo

## 已知待办

- `src/config/signals.ts` 的 `vssPath` 是**待核验的推定路径**，VSS v6.0 有破坏性变更（座椅信号重构、Left/Right → DriverSide/PassengerSide、单位大小写），冻结前必须对着官方 catalog 逐条核对
- 能力目录卡模板已就位，尚未接 Tool Registry 自动生成
- 主动式触发、长期记忆、能力曝光度统计未做

## Golden Case

13 条，在控制面板里点按钮跑真实模型。分四组：Base（链路）· Disambiguation（歧义消解）· Guardrail（边界与拒绝）· Orchestration（卡片编排）。

CAR-bench 的结论是前沿模型倾向"宁可编造工具输出也不承认能力缺失"，所以 Guardrail 组是必测项，不是锦上添花。

## Key 处理

OpenRouter Key 放 `.env.local`（已 gitignore）或直接在控制面板里填。**不要写进任何提交的文件。**
