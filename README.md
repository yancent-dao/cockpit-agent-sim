# cockpit-agent-sim

**面向智能座舱业务的 Agent 框架** —— 零后端、零运行时依赖,加能力 = 加数据不加代码。
An agent framework for smart-cockpit applications. Zero backend, zero runtime deps.

只要在做座舱 AI 相关的事,机制层需要的都是同一套:信号系统(对齐 COVESA VSS)、工具注册与黑/灰/彩权限分级、危险操作确认流(对齐 MCP MRTR)、卡片桌面编排(布局仲裁/抢占/等位区)、快慢双层 Agent pipeline、四级记忆、真实三方集成(导航/天气/音乐/新闻/云端 TTS)。这套底座把机制做完并配了 1170+ 个测试,**接入你的业务 = 往 `src/config/` 加数据**——一条信号、一个 Tool、一条卡片规则,平台代码一行不动。

拿它做什么都行:产品经理搭 Demo(车机屏直接投屏)、工程团队验证座舱 Agent 架构、HMI 设计师探索"无 APP 化"交互、研究快慢双层/生成式 UI 这类 Agent 范式。

![车机屏桌面:导航活地图 + 天气 + 音乐](docs/screenshots/界面1.png)

| 后台子 Agent 调研 + 生成式计算器卡 | 调研交付:生成式报告卡(canvas) |
|---|---|
| ![后台任务进展与生成式卡](docs/screenshots/界面2.png) | ![生成式研究报告卡](docs/screenshots/界面3.png) |

![控制面板:模型选择 · 车辆状态注入 · 全链路追踪](docs/screenshots/控制台.png)

## 快速开始

```bash
npm install
cp .env.local.example .env.local   # 填入你自己的 Key（见文件内注释）
npm run dev                        # → http://localhost:5173
```

打开控制面板 → 选模型(慢层 + 快层)→「打开车机屏」→ 对话框里说话或打字。
试试:「今天天气怎么样」「导航去春熙路」「放首歌」「给我做个计算器」「给孩子讲个故事」。

最低只需一个 [OpenRouter](https://openrouter.ai) Key 即可对话与车控;导航/地图要高德 Key,天气(Open-Meteo)、音乐(iTunes)、电台(Radio Browser)零 Key。

```bash
npm test               # 1142 个测试，全绿才算完成
npx tsc --noEmit       # 类型检查
npm run pilot [场景id] # 自动化体验闭环（消耗真实 API 额度，不进 npm test）
node build-single.mjs  # 单文件版 → single/（双击可开；注意读不到 .env，Key 相关能力不可用）
```

## 系统架构

四条硬约束框定一切设计:**零后端产物**(静态文件;dev/preview 自带纯转发代理免疫 CORS,代理层不许有业务逻辑)· **加能力 = 加数据,不加代码**(新信号/Tool 只改 `src/config/`)· **代码里不许有意图分支**(出现 `if (intent === ...)` 即违规,Agent 表现不好改 Prompt 不改代码)· **运行时依赖为零**(仅 vite / vitest / typescript 三个 devDependency)。

```mermaid
flowchart TB
    subgraph UI["两块屏（同源双窗口，BroadcastChannel 通信）"]
        director["src/director/ 控制面板<br/>模型选择 · 车辆状态注入 · 全链路追踪"]
        screen["src/screen/ 车机屏（可投屏）<br/>卡片桌面 · 语音条 · 横幅 · 覆盖层"]
    end
    subgraph AGENT["src/agent/ 快慢双层 pipeline"]
        fast["快层：小模型<br/>彩权限工具先斩后奏"]
        slow["慢层：大模型<br/>校验 · 接力 · 交付"]
        sub["子 Agent（task.delegate）<br/>独立轮次预算，后台并行"]
        fast -- "agent.handoff<br/>共享 thread" --> slow
        slow --> sub
    end
    subgraph PLATFORM["平台机制（不认识任何具体 Agent）"]
        tools["src/tools/ 注册表<br/>权限三级 · MRTR 确认流 · 返回契约"]
        core["src/core/ 状态引擎<br/>信号 Store · 约束引擎 · 过渡仿真"]
        cards["src/cards/ 卡片编排<br/>布局仲裁 · 抢占 · 等位区 · 布局重力"]
        state["src/state/ 记忆四级<br/>瞬时 · 会话 · 领域 · 长期"]
    end
    subgraph DATA["src/config/ 数据（越多越好）+ agents/ 实例"]
        config["105 信号(VSS) · 67 Tool · 约束 · 卡片规则/模板契约"]
        manifest["manifest + 人设 + 快层微人设 + 技能包"]
    end
    integrations["src/integrations/ 三方适配<br/>高德 · Open-Meteo · iTunes · Radio Browser · NewsAPI · Pexels · OpenRouter 图像"]

    director --> AGENT
    screen <--> cards
    AGENT --> tools --> core --> cards
    tools --> integrations
    AGENT --> state
    DATA -.声明注入.-> PLATFORM
    DATA -.注册.-> AGENT
```

### Agent 的组成部分

**快慢双层(过滤器架构)。** 快层小模型只挂标了 `fast: true` 的彩权限工具(约 16 个,schema 仅 2k token),车控/查询这类简单指令由它亚秒先答、先斩后奏;**无论做没做一律 `agent.handoff` 转交**慢层——两层共享同一 thread,慢层对着调用记录校验、接力剩下的活、没有新增就沉默(回空是合法答案)。整轮越权(NOT_AUTHORIZED)时快层立即收手,被拒的工具名直接预载给慢层。

**工具粒度装载,无"域"概念。** 慢层常驻的是工具目录(每 Tool 一行 brief,0.8k token)+ 常驻管道(voice/card/memory),要用什么调 `tools.load` 点名取。五个元工具(handoff / load / skill.use / task.delegate / task.cancel)由 pipeline 注入,不占业务工具表。

**子 Agent 委托。** 联网查证、成文交付这类耗时重活走 `task.delegate`:拆分决策归慢层模型,一轮连发即并行;background 模式立即返回,完成后机械交付(卡片 + 播报 + 横幅),不叫醒主模型。边界:深度 1、并发 ≤3、子 Agent 无灰权限无语音。

**Skill(章法)。** Tool 是能力,Skill 是章法,人设是品格,记忆是事实——四不相混。技能包放 `agents/main-agent/skills/`(导航、媒体、调研报告、儿童绘本),目录行常驻,`skill.use` 取正文照章执行。

**barge-in 与作废语义。** 每个 turn 带世代戳。用户**追加**一句(stale):旧层活照干完、只是不抢麦,迟到话术降级进横幅;用户**清空会话**(discarded):副作用一起作废。两种作废处置相反,不区分就会出现"重置后幽灵对话复活"。

**记忆四级。** 瞬时(信号 Store,对齐 VSS)→ 会话(域仓结论 + 对话滑窗摘要,小模型异步压缩)→ 领域(播放队列/历史/收藏,localStorage)→ 长期(显式偏好,`memory.remember` 记入,system 注入 ≤10 条)。偏好的自动学习明确不做——显式记忆是数据,自动学习是策略,策略不进代码。

**权限黑/灰/彩。** 彩 = 直接执行;灰 = 二次确认(MRTR 流,判据:不可逆/安全/金钱/涉他人);黑 = 永不注册给 Agent(刹车、转向——工具根本不存在,而非存在但被拒)。

### 卡片编排(模型零参与的那一半)

桌面 = f(车辆状态):基础卡(导航、车控回执)由声明式规则驱动,编排器调和,**模型零参与**;Agent 只为临场内容建卡(候选列表、生成式小组件),走同一布局仲裁。12×8 栅格、14 种形状、每形状一种几何;抢占按 `urgency × kind` 权重,放不下进等位区排队而非消失,空位自动上台;布局重力让卡片只往左上流、结果确定。三条显示通道各司其职:**卡片**(内容)· **横幅**(拒绝原因/回执——对动作的解释不是内容)· **覆盖层**(critical 告警)。`canvas` 模板让模型直出 HTML/SVG 进 Shadow DOM 沙箱——消毒白名单、像素容量契约、升档/缩放/滚动/文字兜底六道闸把不可预测性框住。

### 工程纪律

- **TDD 先红后绿**,1142 个测试全绿才算完成;每个目录有行数预算,超了先查是不是逻辑漏进了不该在的层
- **Tools = 机制,Agent = 策略**:Tool 内不写贴心逻辑,`climate.set` 绝不因为外面冷就自己多加两度
- **不发明命名**:信号对齐 COVESA VSS v6.0,元数据对齐 AAOS 三元组,确认流对齐 MCP MRTR
- **pilot 自动化体验闭环**:独立 LLM 扮"坐在车里的真人"跟真实 Agent 跑多轮对话,落盘快照,按四维清单人工评审

完整需求见 [docs/需求规格说明书_v1.0.md](docs/需求规格说明书_v1.0.md),工程约束见 [docs/工程约束_v1.1.md](docs/工程约束_v1.1.md),各轮设计文档见 [docs/superpowers/specs/](docs/superpowers/specs/)。

## 能力清单（67 Tools）

权限三级:**彩** 直接执行 · **灰** 二次确认(MRTR 流) · **黑** 永不注册给 Agent。⚡ = 标了 `fast: true`,快层小模型可先斩后奏。清单由 `src/config/tools.ts` 声明——**加能力 = 加数据,不加代码**。

<details>
<summary><b>车控与车辆状态</b>（18 个）</summary>

| Tool | 说明 | 权限 | 快层 |
|---|---|:-:|:-:|
| `vehicle.getState` | 读车辆当前状态 | 彩 | ⚡ |
| `capability.list` | 屏上显示能力目录 | 彩 |  |
| `window.set` | 控制车窗开度 | 彩 | ⚡ |
| `climate.set` | 空调温度风量出风 | 彩 | ⚡ |
| `seat.set` | 座椅加热通风调节 | 彩 | ⚡ |
| `steeringWheel.set` | 方向盘加热 | 彩 | ⚡ |
| `sunroof.set` | 天窗开合 | 彩 | ⚡ |
| `mirror.set` | 后视镜折叠与加热 | 彩 | ⚡ |
| `airPurifier.set` | 空气净化器开关档位 | 彩 | ⚡ |
| `wiper.set` | 雨刷挡位 | 彩 | ⚡ |
| `door.set` | 开关车门，需确认 | 灰 |  |
| `trunk.set` | 开关后备箱，需确认 | 灰 |  |
| `chargePort.set` | 开关充电口，需确认 | 彩 |  |
| `childLock.set` | 儿童锁开关 | 彩 | ⚡ |
| `ambientLight.set` | 氛围灯开关颜色亮度 | 彩 | ⚡ |
| `fragrance.set` | 香氛开关香型浓度 | 彩 | ⚡ |
| `light.set` | 大灯与后备箱灯 | 彩 | ⚡ |
| `driveSetting.set` | 驾驶模式回收悬架 | 彩 | ⚡ |

</details>

<details>
<summary><b>导航 · 地图 · 天气（高德 + Open-Meteo）</b>（12 个）</summary>

| Tool | 说明 | 权限 | 快层 |
|---|---|:-:|:-:|
| `navigation.search` | 搜地点出候选列表 | 彩 |  |
| `navigation.setDestination` | 设目的地开始导航 | 彩 |  |
| `navigation.searchAlong` | 沿途周边搜服务点 | 彩 |  |
| `navigation.compareRoutes` | 多路线方案对比 | 彩 |  |
| `navigation.control` | 暂停恢复结束导航 | 彩 |  |
| `navigation.getStatus` | 读导航当前状态 | 彩 |  |
| `map.control` | 地图缩放/全览/2D3D/朝向 | 彩 |  |
| `region.districts` | 查周边区县列表 | 彩 |  |
| `places.save` | 存常用地址 | 彩 |  |
| `places.list` | 列常用地址 | 彩 |  |
| `places.remove` | 删一条常用地址 | 彩 |  |
| `weather.query` | 查城市天气预报 | 彩 | ⚡ |

</details>

<details>
<summary><b>媒体（传输控制共用，内容源各自）</b>（17 个）</summary>

| Tool | 说明 | 权限 | 快层 |
|---|---|:-:|:-:|
| `media.control` | 播放暂停上下曲 | 彩 | ⚡ |
| `media.volume` | 调音量 | 彩 | ⚡ |
| `media.seek` | 跳播放进度 | 彩 |  |
| `media.mode` | 循环随机播放模式 | 彩 | ⚡ |
| `media.queue` | 看播放队列 | 彩 |  |
| `media.favorite` | 收藏当前曲目 | 彩 |  |
| `media.favorites` | 列收藏列表 | 彩 |  |
| `music.search` | 搜歌不播 | 彩 |  |
| `music.play` | 搜歌并播放入队 | 彩 | ⚡ |
| `radio.search` | 搜网络电台 | 彩 |  |
| `radio.play` | 搜台并播放 | 彩 | ⚡ |
| `news.headlines` | 今日头条新闻 | 彩 | ⚡ |
| `news.search` | 按话题搜新闻 | 彩 | ⚡ |
| `news.read` | 念一条新闻正文 | 彩 |  |
| `video.search` | 搜短视频 | 彩 |  |
| `video.play` | 搜视频并播放 | 彩 | ⚡ |
| `web.search` | 联网搜索现查 | 彩 |  |

</details>

<details>
<summary><b>语音与屏幕</b>（9 个）</summary>

| Tool | 说明 | 权限 | 快层 |
|---|---|:-:|:-:|
| `voice.speak` | 主动播报一句话 | 彩 |  |
| `voice.ask` | 向用户提问出选择卡 | 彩 |  |
| `voice.config` | 换朗读音色、调语速 | 彩 |  |
| `card.show` | 建卡片上屏 | 彩 |  |
| `card.update` | 更新卡片数据 | 彩 |  |
| `card.resize` | 调卡片大小 | 彩 |  |
| `card.dismiss` | 撤掉卡片 | 彩 |  |
| `card.focus` | 高亮提示一张卡 | 彩 |  |
| `desktop.getLayout` | 读桌面布局 | 彩 |  |

</details>

<details>
<summary><b>记忆</b>（3 个）</summary>

| Tool | 说明 | 权限 | 快层 |
|---|---|:-:|:-:|
| `memory.remember` | 记住用户偏好 | 彩 |  |
| `memory.forget` | 删掉记住的偏好 | 彩 |  |
| `memory.list` | 列出记住的事 | 彩 |  |

</details>

<details>
<summary><b>AI 儿童绘本「路上的故事」</b>（7 个）</summary>

| Tool | 说明 | 权限 | 快层 |
|---|---|:-:|:-:|
| `story.profile` | 记下孩子的名字年龄和这次想讲明白的道理 | 彩 |  |
| `story.cast` | 把孩子的照片画成故事主角 | 彩 |  |
| `story.begin` | 开一本新绘本，讲第一章 | 彩 |  |
| `story.continue` | 接着孩子说的往下写一章 | 彩 |  |
| `story.finish` | 收尾成书 | 彩 |  |
| `story.export` | 把这本书做成可以发给别人的网页 | 彩 |  |
| `story.page` | 翻页/暂停（屏幕按钮直调，不叫醒模型） | 彩 |  |

</details>

<details>
<summary><b>安全边界</b>（1 个）</summary>

| Tool | 说明 | 权限 | 快层 |
|---|---|:-:|:-:|
| `brake.apply` | 黑名单占位：刹车这类工具**永不注册给 Agent**，留在配置里只为标出禁区 | 黑 |  |

</details>

## Key 与第三方服务

| 服务 | 用途 | Key | 条款须知 |
|---|---|---|---|
| OpenRouter | 对话 + 绘本插图 | 必填 | 图像 $0.07/张左右,面板有花费显示 |
| 高德开放平台 | 导航、地名解析、活地图 | 可选,两个 Key | 控制台需把 `localhost` 加入域名白名单 |
| Open-Meteo | 天气(逐时/多日) | **零 Key** | 数据 CC BY 4.0,对外材料请注明 *weather data by [Open-Meteo](https://open-meteo.com)* |
| iTunes Search | 音乐(30 秒试听) | 零 Key | 仅试听片段,无完整播放 |
| Radio Browser | 网络电台 | 零 Key | 社区节点,可用性有波动 |
| NewsAPI | 新闻 | 可选 | ⚠ 免费层**仅限 localhost,禁止部署** |
| Pexels | 短视频 | 可选 | — |
| 讯飞开放平台 | 云端超拟人 TTS(可选,不配则用浏览器本机音色) | 可选,三个值 | 免费额度以控制台为准 |

所有 Key 都写在本地 `.env.local`(已 gitignore)或控制面板里,**零后端,不经过任何中间服务器**。

## 隐私须知(绘本功能)

「路上的故事」会把**儿童照片发给第三方图像模型**(OpenRouter)用于生成动漫形象。项目本身不存储任何照片(没有后端;`public/hero/` 已整体 gitignore),但部署/演示给他人前请确认监护人知情同意——界面里的授权勾选是一次性明确动作,不是默认开关。

## 明确不做

后端 · 数据库 · 多屏 · 日夜切换 · CAN 报文级仿真 · 偏好自动学习(显式记忆是数据,自动学习是策略)。完整清单见 [docs/工程约束_v1.1.md](docs/工程约束_v1.1.md)。

## License

[MIT](LICENSE)。第三方服务各有条款,见上表。
