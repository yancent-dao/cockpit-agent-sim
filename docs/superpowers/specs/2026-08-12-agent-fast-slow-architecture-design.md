# Agent 快慢双通道架构（响应速度与可扩展性重设计）

> 2026-08-12。触发：五条产品诉求——①全量 Tools 上下文过长响应慢；②车控/天气要亚秒级；
> ③一句话多意图要并行；④要不要 Skill 机制；⑤轮数增多不能变慢，记忆要异步。
> 目标：**无论多少 Tools、多少轮对话，响应时间恒定**；加 Tool 零改代码自适应。

## 0. 现状瓶颈（实测链路）

`src/agent/runtime.ts` 是单层循环：每轮把 **55 个工具 schema（约 8k token）+
全量车辆状态（50 行）+ 无上限的完整对话历史** 送进一个模型，串行最多 6 轮。

| 瓶颈 | 根因 | 后果 |
|---|---|---|
| 上下文肥大 | 55 schemas 每轮全量 | 首字延迟随工具数线性涨；>30-50 个工具后模型选错率上升（Anthropic 官方结论） |
| 简单指令也走全链路 | "开窗"和"规划带娃路线"同一条路 | 车控 1.5-3s，无法亚秒 |
| 串行轮次 | 一轮一往返 | 复杂任务 5-15s |
| history 无上限 | 从不压缩 | 越聊越慢，直到爆上下文 |
| system 每轮重建且状态在中间 | 车辆状态混在 persona 后面 | provider 端 prompt cache 永不命中 |

## 1. 市场调研结论（2026-08）

- **Anthropic Tool Search**（2025-11 beta，2026-01 进 Claude Code）：官方承认"全量塞工具"
  是反模式——defer_loading + BM25/regex 按需发现，token 省 85%。经 OpenRouter 用不到
  这个 beta，但思想可以自建：**工具按需装载是行业定论，不是我们的猜测**。
- **Claude Skills**（2025-10）：三级渐进披露（目录行常驻 → 命中才载正文 → 引用文件用时才读），
  "几十个 skill 不胀上下文"的公认解法。
- **量产车双系统已是共识**：理想"快慢思考"（端到端快系统 + VLM 慢系统）、华为 MoLA 2.0
  多 Agent 混合、小鹏"25 秒十连指令"主打快通道、小米 0.3s 冷启动。**快慢分层不是实验室
  玩法，是 2026 量产竞争的入场券**。
- **记忆**：生产主流 = 滑动窗口（最近 K 轮全文）+ 摘要前缀，异步压缩；
  MemGPT/Letta 的"核心记忆常驻 + 档案记忆按需取"分层已是标准词汇。
- **级联路由**（FrugalGPT/RouteLLM）：小模型先接、接不住升级大模型，成本降一个量级。

## 2. 目标架构：三层通道

```
用户一句话
   │
   ▼
┌─ L0 反射层（毫秒级，二期）────────────────────────────┐
│ "话术→工具调用"编译缓存（归一化全句精确匹配）           │
│ 命中 → 直接 registry.invoke + 模板话术   <50ms        │
└─ miss ↓ ──────────────────────────────────────────────┘
┌─ L1 调度层 Dispatcher（小模型，亚秒）──────────────────┐
│ 上下文极小：微 persona(3行) + 域目录(17行,复用          │
│ CAPABILITY_DOMAINS) + Skill 目录 + 状态摘要 + 最近2轮   │
│ 一轮强制 function calling，输出 dispatch(...)：         │
│   directCalls: 简单指令直接吐调用+话术 → 执行完就答     │
│   intents[]:   复杂/多意图 → 拆段派发给 L2             │
│   cacheable:   这句话可否进 L0 缓存（模型判断，非代码） │
└─ 需要深度处理 ↓ ──────────────────────────────────────┘
┌─ L2 执行层 Worker（主模型，按意图并行）────────────────┐
│ 每个 worker 只带：命中域的 tools(8-12个) + 常驻域       │
│ (voice/card/memory) + 命中 Skill 的注入正文 + 分层记忆  │
│ N 个意图 = N 个 worker 并行，Promise.all               │
│ 话术汇总：单意图 worker 直接说；多意图由 dispatcher     │
│ 再跑一轮合并（同一个小模型，保持口吻一致）              │
└────────────────────────────────────────────────────────┘
```

### 与四条硬约束的对账

- **不许意图分支**：路由决策 100% 由 dispatcher 模型的结构化输出决定，代码里没有任何
  一条 `if (包含"开窗")`。L0 缓存的键是归一化全句、值是模型自己编译过的调用——
  是运行时学来的数据，不是手写关键词表；可否入缓存也由模型标注。
- **平台不认识具体 Agent**：dispatcher/worker 的域目录、Skill 目录全部来自 manifest
  与 config 数据，编排器通用。
- **加能力 = 加数据**：新 Tool 前缀命中已有域 → 全链路零改动自动进目录/进装载；
  新域 → `CAPABILITY_DOMAINS` 加一行。Skill 同理，加文件即生效。
- **零后端/零依赖**：全部跑在浏览器，模型仍走 OpenRouter。不引入向量库/embeddings
  （OpenRouter 无 embeddings 端点；语义缓存列为远期，见 §8）。

### Agent 公理修订（需要记录）

原："代码只做四件事：上下文拼装、并行调用、结果回填、确认流转"。
修订：**编排的"结构"进代码（分层、并行、缓存、压缩都是机制），编排的"决策"留在模型**
（哪个域、几个意图、可否缓存、何时升级）。判据不变：代码里出现意图字符串比对即违规。

## 3. 分域装载（Tool Loading by Domain）

- 数据源复用 `CAPABILITY_DOMAINS`（能力目录卡同一张表——给用户看的目录和给
  dispatcher 看的目录本来就该是同一份，两处画面一个真相）。
- 表新增一列 `signals?: string[]`（信号别名前缀）：worker 的车辆状态注入也按域裁剪
  ——车窗意图不需要 50 行全量状态，注入 `cabin.window.*` + 通用行（车速/挡位/说话人）。
- 常驻域（每个 worker 都挂）：`voice.* / card.* / memory.* / vehicle.getState`。
- 兜底：dispatcher 输出 `domain: 'unknown'` → 该 worker 全量装载（等于今天的行为），
  宁慢不错。trace 记录每次 dispatch 决策，pilot 跑批统计误路由率。

## 4. Skill 机制（要，二级渐进披露）

**作用**：把"多步骤 know-how"从常驻 persona 挪到按需注入。persona 保持 22 行纪律不再膨胀，
而"顺路充电怎么找桩、比价、设途经点"这类剧本可以无限加。

```
agents/main-agent/skills/<name>.ts
  { name, whenToUse: '给 dispatcher 的一行触发描述',
    inject: '命中后注入 worker system 的正文（≤40 行）',
    tools?: ['额外解锁的工具'], domain?: '归属域' }
```

- 一级（常驻）：所有 skill 的 `name + whenToUse` 拼进 dispatcher 目录，每个一行。
- 二级（命中）：dispatcher 点名 → 正文注入对应 worker。
- 不做三级（引用文件）——浏览器环境没有文件系统渐进读取，二级够用。
- Skill 是数据：加 skill = 加文件 + manifest 挂名，平台零改动。

首批候选：顺路充电、长途规划（途经点+天气联查）、接娃场景、媒体续播偏好。

## 5. 异步分层记忆

```
history = [ epoch 摘要（≤10 行，assistant 角色置顶） ] + [ 最近 K=4 轮全文 ]
```

- turn 的 reply 一出（用户已听到答案），fire-and-forget 让小模型把最老的溢出轮次
  折叠进摘要——**压缩不占响应路径的一毫秒**。
- 压缩失败：保持原样，下轮重试（宁长勿丢）。压缩未完成新 turn 已来：放弃本次压缩。
- 与既有四级记忆的关系：这是"会话级"的对话摘要，补在 瞬时(store)/会话(session)/
  领域(domain)/长期(prefs) 中会话那一级的缺口——session.ts 现在只有域仓结论摘要，
  没有对话本身的摘要。
- 效果：**上下文尺寸与轮数解耦**，第 100 轮和第 5 轮一样快。

## 6. Provider 层加速（不改架构的白捡项）

- **system 重排**：稳定前缀（persona + skill 目录 + 域目录）在前，易变内容（车辆状态、
  桌面摘要）挪到 system 尾部甚至首条 user 消息——OpenRouter 透传 Anthropic
  `cache_control` / OpenAI 自动前缀缓存，命中后 TTFT 显著下降。
- **状态注入瘦身**：按域裁剪（§3），50 行 → ~12 行。
- **streaming**：`llm.chat` 支持流式，配合车机屏逐字播报，体感首响提前 1-2s（工程项）。

## 7. 响应速度预算（验收线）

| 路径 | 现状 | 目标 |
|---|---|---|
| L0 命中（重复车控指令） | 1.5-3s | **<50ms** |
| L1 直执（车控/天气单意图） | 1.5-3s | **<1s**（dispatcher 一轮 300-700ms） |
| L2 单复杂意图 | 5-15s | 2-4s（域装载后 schema 从 8k→1.5k token） |
| L2 多意图 | 串行累加 | 并行，= 最慢分支 |
| 第 50 轮对话 | 线性变慢 | 与第 5 轮持平（恒定上下文） |

pilot 新增计时断言：每场景落盘 dispatch 决策 + 分层耗时，RUBRIC 增"速度"维度。

## 8. 明确不做 / 远期

- **语义缓存（embedding 相似度）**：OpenRouter 无 embeddings 端点，引入第二家 API
  只为缓存不值当；先看 L0 精确缓存命中率数据再说。
- **本地小模型（WebLLM/端侧 NPU）**：零依赖约束 + Demo 定位，不做。
- **跨 worker 信号写冲突仲裁**：一句话里自相矛盾的写（"开窗并关窗"）交给约束引擎
  与不变量兜底，不做事务层。实测出现再议。
- **dispatcher 独立 persona 调优**：先复用主 persona 微缩版，pilot 数据说话。

## 9. 实施分期（每期 TDD + pilot 跑批验收）

- **P1（架构主体）**：①分域装载 + 域表加 signals 列；②dispatcher 快通道
  （directCalls 路径）+ 多意图 fan-out；③异步记忆压缩；④system 重排缓存前缀。
- **P2（锦上添花）**：⑤L0 反射缓存；⑥Skill 机制 + 首批 4 个 skill；⑦streaming。
- 预算：`src/agent/` 500 → **800 行**（dispatcher、fan-out、压缩、缓存四块新机制进驻，
  与 cards 目录上调同一判据：机制进驻不是逻辑漏进）。超了先查是不是策略漏进了代码。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 小模型误路由（选错域/漏意图） | unknown 兜底全量；trace 全记录；pilot 统计误路由率，>5% 则换 dispatcher 模型 |
| L0 脏命中（同话不同意图） | 只缓存 dispatcher 标 cacheable 且"彩"权限的调用；约束引擎照常跑（行驶中该拒还是拒）；状态版本戳失效 |
| 多 worker 话术打架 | 多意图时话术统一由 dispatcher 合并轮出口 |
| dispatcher 自身成为延迟下限 | 上下文压到 <1k token；选 TTFT 最快档模型（面板已有"只看快速模型"筛选） |
| 两段模型成本翻倍 | dispatcher 用 $0.1/M 级模型，单次 <0.01 分钱；省下的 8k schema token 远大于此 |

## 来源

- [Anthropic Tool Search 解析](https://growthmethod.com/anthropic-tool-search/) ·
  [Claude Code MCP tool search](https://tessl.io/blog/anthropic-brings-mcp-tool-search-to-claude-code/)
- [Agent Skills 官方文档](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) ·
  [渐进披露设计模式](https://www.newsletter.swirlai.com/p/agent-skills-progressive-disclosure)
- [2026 车载语音对比（理想/蔚来/小鹏）](https://www.21jingji.com/article/20250429/herald/e13c25cef886f020f174cece62ab1752.html) ·
  [2026 座舱语音评测](https://db.m.auto.sohu.com/model_6516/a/1030412502_122864692)
- [Agent 记忆生产指南 2026（Letta/Mem0/Zep）](https://jobsbyculture.com/blog/ai-agent-memory-systems-guide-2026) ·
  [长会话上下文压缩](https://zylos.ai/research/2026-04-21-agent-context-compaction-long-running-sessions/)
