# 座舱 Agent 模拟环境

给座舱产品经理做 AI Demo 用的公共底座。目标不是做一个产品，是让每次做 Demo 不用从零开始。

完整需求见 `docs/需求规格说明书_v1.0.md`，工程约束见 `docs/工程约束_v1.1.md`。**这两份是唯一事实来源，改设计前先读。**

## 命令

- 测试：`npm test`（当前 750 个，必须全绿才算完成）
- 监视：`npm run test:watch`
- 自动化体验闭环：`npm run pilot [场景id...]`（见下方「Pilot」）
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
  > 2026-08-10 限定例外：导航卡要接高德地图 JS SDK 画真实地图瓦片，产品决策明确要接受这个代价。**只对导航卡这一个功能生效**，其它地方新加依赖仍然按这条硬约束卡。落地方式：运行时用 `<script>` 动态加载高德 JS API（不装 `@amap/amap-jsapi-loader` 之类 npm 包），package.json 的 devDependencies 保持不变，代价体现在"运行时需要联网加载第三方脚本"而不是"构建时多一个包"。

## 结构与规模预算

```
src/config/    signals · constraints · tools · cards —— 数据，越多越好
src/core/      State Store · 约束引擎 · 过渡仿真 · 不变量断言    < 800 行（现 242）
src/tools/     注册表 · 能力授权 · 返回契约 · MRTR 确认流        < 600 行（现 401）
src/integrations/  三方适配。分两层，预算口径不同：
               ① 协议客户端 —— **每个 < 200 行**，超了通常是业务逻辑漏进来了
                  radio 100 · news 93 · itunes 71 · pexels 66 · websearch 49
                  ⚠ amap 363 **超标**：高德一家提供搜索/路径/天气/行政区/静态图/公交
                    十几个接口，接口数量本身就比别家高一个量级。要拆的话按接口族
                    分文件（amap/place.ts、amap/route.ts…），暂时记在这里不装看不见
               ② handler 层 —— 业务逻辑，行数跟 Tool 数量成正比，按**每 Tool < 40 行**看
                  mediaHandlers 413 / 17 Tool = 24 · navHandlers 376 / 11 Tool = 34
src/cards/     卡片桌面 · 栅格 · 编排器 · 生命周期 · 抢占 · 恢复 · 等位区   < 900 行（现 855）
               > 2026-08-13 从 800 上调：等位区（offstage/staged）进驻——
               "放不下"从失败变状态，挤出/放不下的卡排队而非消失，
               reconcile 补一条被动上台通道、render() 补一条主动重试通道。
               见 docs/superpowers/specs/2026-08-13-desk-offstage-design.md
               > 2026-08-12 从 700 上调：家族机制、reconcile 恢复通道、几何闸
               （contract）、尺寸自愈（heal）、模型视角生成器（summary）五块
               **机制**进驻——都是本轮设计新增的职责，不是逻辑漏进来。
               判据不变：再超先查是不是业务逻辑混进了仲裁
src/agent/     快慢双层 pipeline · 上下文注入 · OpenRouter          < 800 行
               > 2026-08-12 从 500 上调：过滤器（快层先斩）、工具粒度装载
               （目录+预载+补载）、task.delegate 子 Agent、异步记忆压缩、
               turn 世代戳 barge-in——五块**机制**进驻（设计文档
               2026-08-12-agent-fast-slow-architecture-design.md）。
               判据不变：编排的"决策"（做不做/拆不拆/要不要开口）必须在模型，
               代码出现意图字符串比对即违规
src/state/     记忆系统：域仓（队列/历史/收藏）· 偏好 · 会话摘要        < 300 行
src/design/    Design Token（CSS 文本常量）—— 算数据不算代码，不占预算
src/screen/    车机屏（纯净可投屏）      ← 不许有业务逻辑
               展示逻辑（转向条文案、日期人性化、档位→形态、HTML 消毒、
               FLIP、横幅排队、时长格式化）可以放这，但**必须抽成纯函数配测试**。
               现在 512 行纯函数全有测试，main.ts 那 500 行是 DOM 操作。
               超预算时先看是不是有逻辑漏进来了
src/director/  控制面板（调试/演示）      ← 不许有业务逻辑
agents/        Agent 实例：manifest + 人设 + fast.ts（快层微人设）+ skills/（技能包）
```

超预算时不要提高预算，先检查是不是有逻辑漏进了 UI 层。

`src/integrations/` 是后加的一档，不是给 `src/tools/` 抬预算。原来那 600 行只算平台机制
（注册表、授权、契约、MRTR），写下它时"接三方"这件事整个不在设计里。高德接进来之后
`src/tools/` 一度到 1098 行，拆开才看清超的全是协议适配——registry.ts 本身 375 行，
一直在预算内。分开记也逼出一条边界：**平台不该认识高德**，就像它不认识任何具体 Agent。

> 2026-08-11：接媒体域（5 个 CP）时把总量上限拆成了上面那两层口径。
> 三方数量是业务决定的（产品要接几个 CP），用总量卡它等于用架构预算限制产品范围，
> 卡错了地方。单个适配的复杂度才是架构问题——超过 200 行通常说明业务逻辑漏进适配层了。
> handler 层则跟 Tool 数量成正比，用固定行数卡它同样卡错了地方，所以按人均看。

## 复杂度的三个落点，各有上限

- **约束引擎**：只支持 `[path, op, value]` 三元组，不支持嵌套逻辑。复杂场景写具名谓词函数登记白名单。**绝不引入 eval 或表达式引擎。**
- **卡片布局**：基础栅格 12×4（48 单元），档位 10 个，**每个档位只允许一种形状**。宽度限偶数列、列起点限偶数——保证空隙必为偶数宽、`chip`（宽 2）永远填得上，**不出现死缝**（3×2 栅格下 2/3 卡右边留一条宽 1 的竖缝，横向 1/3 卡永远放不进去，跑批时抓到过整张导航卡出不来）。位置仍可枚举（6 列位 × 4 行位）。**不追求最优解，追求可预测解**——演示者能预判结果比空间利用率重要。
  尺寸本身是活的：模板声明 `defaultSize`，通用池 1/6 · 1/3 · 1/2 全部可用（详见
  `docs/superpowers/specs/2026-08-11-card-size-adaptive-design.md`）。**2/3 和 full 不进池**——
  前者全桌面只有一个合法位置，两张必冲突；后者是覆盖层不是尺寸，任意卡能 full 意味着
  天气能盖住导航。尺寸优先级：**物理（仲裁缩放）> 意愿（用户 resize）> 建议（defaultSize）**，
  中间那层就是 `sizeLocked`——不做的话用户说"地图小一点"，下一秒 ETA 一跳就弹回去。
- **Agent 编排**：全部在 Prompt 里。代码只做四件事：上下文拼装、并行调用、结果回填、确认流转。
- **生成式卡（2026-08-12 新增的第四个落点）**：`canvas` 模板让模型直出 HTML/SVG，
  渲染进 Shadow DOM。**这一条跟"可预测优先于最优"正面冲突**——同一句话两次演示
  可能长得不一样，产品已知并接受这个代价。三道闸把不可预测性框住：
  ① 消毒器白名单（`src/screen/sanitize.ts`，解析 + 重新序列化，fail-closed，七条攻击用例）
  ② 像素契约（各档位真实像素拼进模板描述，不给它必然溢出）
  ③ pilot 硬伤（消毒后为空 = 白开一张 canvas、没给 text 兜底 = 剥空时白屏）
  Tool 描述里写死"能用 list/generic 表达的就别用"。

## 卡片编排（2026-08-10 重设计，详见 docs/superpowers/specs/2026-08-10-card-orchestration-design.md）

> 公理（2026-08-12）：**卡片是"带契约的投影"，不是容器。** 数据层集中（信号 + 域仓）、
> 逻辑层集中（handler/规则 = 机制，Prompt = 策略）、样式层集中（token）。模板契约三件套：
> 数据形状（fields）· 形态（forms）· 交互声明（interactions）。全系统唯一的容器是
> canvas-app（iframe 沙箱逃生舱）——它的存在意义恰恰是让其它卡片不必升级为容器。

- **桌面 = f(车辆状态)**：基础卡片（导航、车窗反馈）由 `src/config/cardRules.ts` 的声明式规则驱动，`src/cards/orchestrator.ts` 调和，**模型零参与**。加场景 = 加规则 + data builder，不改编排器
- 桌面统一 48 单元（12×4）无分区、无常驻卡、默认为空；导航中导航卡 2/3 左锚定且不可被挤，导航结束自动退场
- **紧急度正交于来源**（2026-08-12）：`kind` 说"谁建的卡"，`urgency` 说"这事有多急"。
  只看 kind 的话，车门没关且已起步的安全告警跟天气卡同为 rule，抢位时按 LRU 决定谁活。
  权重表在 `src/config/priority.ts`，urgency 步长 10 而 kind 步长 1——差一个数量级
  紧急度才压得过来源。`critical` 放不下时改走覆盖层，**绝不返回 DESKTOP_FULL**
- **三条显示通道**（2026-08-12）：卡片（常态内容，进桌面）· 横幅（拒绝原因、约束不满足、
  挤出告知——这些是对某个动作的**解释**不是内容，塞进桌面会占掉 1/6 格子还跟内容卡长得一样）·
  覆盖层（critical 告警 / full 档内容）。分派在 `channelOf()`，判据只看卡片自己的字段
- Agent 只为规则覆盖不到的临场内容建卡（候选列表、临时提醒），走同一布局仲裁
- 业界对标：Generative UI 的 Static 模式 + CarPlay/Android Auto 模板方法论

## 媒体域（2026-08-11，详见 docs/superpowers/specs/2026-08-11-media-domain-design.md）

音乐 · 电台 · 新闻 · 联网搜索 · 短视频，17 个 Tool，**卡片模板新增 0 个**（列表类全部复用 `list`）。

- **传输控制共用，内容源各自**：`media.*`（播放/音量/进度/模式/收藏）不认内容源，
  `music.* / radio.* / news.* / video.*` 各归各的 CP。对标 MediaSession 与 MPRemoteCommandCenter
- **播放进度不进 store**。position 每秒变好几次，进信号系统就是每秒重评规则。
  **状态 vs 遥测**这条界线不划清，以后车速转速电流都会往里挤
- **bus 双向**，但车机屏只上报设备事实（放完了/放不出来），不上报决定
- **自动播放要先解锁**：车机屏是被动弹出的窗口，没交互过第一首歌会被静默拒绝
- 行驶禁播视频走**约束引擎**（`media.videoActive` 专用信号——约束的 target 只匹配路径
  不看值，打在 `media.source` 上会连音乐一起拦）

CP 全是实测选出来的，几个坑记在设计文档里：iTunes 不支持 CORS 得走 JSONP；
Radio Browser 的**主域名 404**、只有具体节点能用而且会挂；NewsAPI 的 `country=cn`
返回 0 条、免费层只对 localhost 开放且禁止部署。

**没有任何个人可注册的免费 CP 能提供华语流行乐完整播放**，iTunes 只给 30 秒。
做 Demo 脚本时就得知道。

## Agent 快慢双层（2026-08-12，设计文档 agent-fast-slow-architecture-design.md）

- **过滤器架构**：快层小模型只挂 `fast: true` 的彩权限工具（~16 个，schema 2k token），
  能做的立刻做、立刻说；**无论做没做一律转交**慢层（共享同一 thread）——慢层校验、
  接力、静默判断（回空=合法）。先斩后奏的风险边界 = 既有黑/灰/彩分级。
- **工具粒度装载，无"域"**：慢层常驻 = 工具目录（每 Tool 一行 `brief`，0.8k token）
  + 常驻管道（voice/card/memory）+ 快层勾选（agent.handoff）预载 + `tools.load` 补载。
  元工具（handoff/load/skill.use/task.delegate/task.cancel）是 pipeline 注入的，不进 TOOLS。
- **task.delegate**：拆分决策归慢层模型，一轮连发 N 个即并行；background 模式立即返回
  taskId、完成机械交付（卡+播报+横幅，语音忙则排队）。边界：深度 1 / 并发 ≤3 /
  子 Agent 无灰权限无 voice。状态栏 ⟳ 任务芯片，点开任务列表卡。
- **barge-in**：turn 世代戳。旧慢层活照干完、话术降级 lateNote 走横幅、消息插新输入前。
  pending MRTR 确认时新输入直达慢层（状态分支不是意图分支）。
- **Skill**（agents/main-agent/skills/）：目录行常驻 + skill.use 注入正文（≤40 行）。
  首批导航、媒体、调研报告（canvas 交付）。Tool=能力 Skill=章法 persona=品格 记忆=事实，四不相混。
- 实测经验：快层最后一轮必须撤工具逼话术（GLM-flash 会两轮全用来重复调用）；
  快层模型别选最便宜档（裸小模型调不动工具）；数值参数要宽容 "24" 字符串。

## 记忆系统（2026-08-12，四级 + 会话对话摘要）

瞬时（信号 store，VSS）→ 会话（`src/state/session.ts` 域仓结论 ≤3 行 + pipeline 的
对话 epoch 摘要：最近 4 轮全文 + 摘要头，回复送出后小模型异步压缩，含实体索引行；
"上回说到"落 localStorage 跨会话一行）→
领域（`src/state/domain.ts`：播放队列/历史/收藏，localStorage）→
长期（`src/state/prefs.ts`：显式偏好，注入 system ≤10 条）。

- **域数据不进信号 store**——store 对齐 VSS，"这条界线不划清，车速转速电流都会往里挤"
- **队列刻意不持久化**：跟播放态绑定，刷新后恢复一条悬空队列只会让"下一曲"播错
- `ended` → 机制自动续播（`createAutoplay`，零模型）——iTunes 30 秒试听因此像电台一样流动
- 偏好 handler **一个 if 都不解析内容**，落实靠模型对着 system 注入做（机制/策略分界）

## 权限分级：黑 / 灰 / 彩

- **彩** auto，可直接执行
- **灰** confirm，需二次确认（判据：不可逆 / 涉及安全 / 涉及金钱 / 涉及他人）
- **黑** 永久禁区，**永不注册给 Agent**（刹车、转向）

注意区分「黑」（Tool 根本不存在）和 `rejected`（Tool 存在但本次条件不满足）——早期版本混淆过这两个。

## 明确不做

后端 · 数据库 · 多屏 · 日夜切换（`screen.setTheme` 这类运行时主题切换）· 完整设计系统 · Tool 路由（14 个直接全量挂载）· CAN 时延与报文级仿真 · monorepo · 屏幕形态多样化（竖屏 / 超宽——栅格常量写死在 `src/config/grid.ts`，将来要加时改这一处）· **偏好的自动学习**（"他连续三次调 24 就记住"——显式记忆是数据，自动学习是策略，策略进代码违反"不许意图分支"）

> 2026-08-12：**触控交互从"明确不做"移除**（产品决策变更）。屏幕可点选：三类路由
> （回答类→合成用户输入进对话 / 操控类→直调 Tool 不叫醒模型 / 管理类→直调 desk 记入意愿层），
> 交互靠模板契约里的**声明**（`src/config/interactions.ts`）分发，手势层零路由决策。
> 语音仍是主通道，pilot 检测从"让点屏幕=硬伤"反转为"催促点屏幕=提示"。

> 2026-08-10：车机屏已改为单一**日间**配色（之前是单一夜间配色），这是一次性重绘 Design Token，不是加了主题切换能力——「不做日夜切换」这条约束本身没变。

## 已知待办

- `src/config/signals.ts` 的 `vssPath` 是**待核验的推定路径**，VSS v6.0 有破坏性变更（座椅信号重构、Left/Right → DriverSide/PassengerSide、单位大小写），冻结前必须对着官方 catalog 逐条核对
- 主动式触发、能力曝光度统计未做。"等我降下速你就给我开窗"仍只能答"你降下来喊我一声"——
  落地路径已定（触发器 = 向用户开放的规则引擎，CardRule 形状 + `src/state/` 存储），见
  `docs/superpowers/specs/2026-08-12-agent-centric-cockpit-design.md` §1.5。
  长期记忆的**显式半边已做**（memory.remember/forget/list + system 注入）；自动学习明确不做
- 单文件版（`node build-single.mjs`）读不到 `import.meta.env`——esbuild 打成 iife 后它恒为空。
  高德和 OpenRouter 的 Key 全部拿不到，导航/天气/地图在双击打开的那个版本里等于没有。
  修法是控制面板加输入框 + localStorage，**不能靠 build 时 define 注入**（产物要提交，
  Key 不许进提交的文件）

## Golden Case（已移除）

> 2026-08-10：控制面板里的 Golden Case 按钮与相关代码已按产品决策彻底删除，不再是必测项。历史设计记录见需求规格书 §8.2/§8.3（已标注过期）。真实模型验证目前靠手动在对话框里输入话术。

## Pilot：用户机器人自动化闭环

`npm run pilot [场景id...]` —— 用一个独立的 LLM 扮"坐在车里的真人"，跟真实 Agent 跑多轮对话，
落盘结构化快照（用户说了什么 / 调了哪些 Tool / 桌面最终有哪些卡 / 话术）到 `tests/pilot/runs/`。

- **机器人只负责说人话，不做判断**。好不好、对不对由人对着 `tests/pilot/RUBRIC.md` 四维清单评审：
  产品设计 · 用户交互 · 架构 · 界面
- `tests/pilot/scenarios.ts` 是纯数据，加场景 = 加一条。55 条分 nav/ctrl/chat/media 四组，
  可以按组跑（`npm run pilot -- nav`）也可以按 id 跑。四组：nav / ctrl / chat / media
- run.ts 的检测分两级：**硬伤**（DESKTOP_FULL、导航中无导航卡、话术声称"屏幕上有"但桌面空、
  thinking 标签泄漏、泄漏模型身份、说"第几个"但屏上没编号……触控落地后
  "让用户点屏幕"从硬伤降为提示，只抓**催促**点击）
  和**提示**（话术偏长这类，需要人看一眼再判断）。混在一起报会让真问题被淹掉
- 会消耗真实 OpenRouter/高德额度，所以**不进 `npm test`**

已用它抓到并修掉的真问题：两张选择卡并存、几何死局导致导航卡整个出不来、
`</mm:think>` 泄漏进播报、空输入时 Agent 凭空发挥、话术让用户点不可交互的屏幕、
模型把 6 轮全用在调工具上导致用户一句话没听到、成都的用户搜"临平"命中杭州。

### 跑批跑出来的三条经验

1. **Tool 描述和人设打架时，模型两边都想满足，结果两边都不对。**
   `navigation.search` 曾写着"用 voice.ask 把候选念出来"，人设第 8 条又说"屏上有的别逐条念"，
   于是出了 123 字的话术把四个候选念了一遍。查一条奇怪话术，先看是不是指令在互相矛盾。
2. **Tool 描述是给模型的指令，不是给自己的备忘录。** 往 desc 里写过一句
   "实测有模型调完就回一句'问题已经念给你了'"，模型直接把这段元信息当成要跟用户说的话念了出来。
3. **撤卡时机分两类，别混。** 问题卡（voice.ask、MRTR 确认）用户一开口就该撤——
   要么答了要么跳过了。候选/结果卡**不能**这么撤：实测用户的下一句常常正是冲着屏幕问的
   （"上面那个离这儿多远？"），撤了他就没东西可指。后者按"这件事翻篇"撤
   （设了目的地、比完路线、存成常用地址）。

## Key 处理

OpenRouter Key 放 `.env.local`（已 gitignore）或直接在控制面板里填。**不要写进任何提交的文件。**

高德地图接入后会用到**两个不同的 Key**（容易搞混）：
- **Web 服务 Key**：`navigation.search`/`setDestination` 这类 REST 调用用，走 `src/tools/amap.ts`
- **Web端(JS API) Key** + 安全密钥（jscode）：车机屏加载地图组件用，走 `<script>` 标签
两个都放 `.env.local`（`VITE_AMAP_WEB_KEY` / `VITE_AMAP_JS_KEY` / `VITE_AMAP_JS_SECRET`），且要在高德控制台把域名加进白名单（本地开发通常要加 `localhost`）。
