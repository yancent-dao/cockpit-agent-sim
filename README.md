# cockpit-agent-sim

**给座舱产品经理的 AI Agent 模拟环境** —— 零后端、零运行时依赖的智能座舱 Demo 公共底座。
An agent-centric smart-cockpit simulation sandbox. Zero backend, zero runtime deps.

目标不是做一个产品,是让每次做座舱 AI Demo 不用从零开始:真实 LLM 驱动、真实第三方 API(导航/天气/音乐/新闻),车机屏可直接投屏演示。

<!-- TODO: 放 2–3 张截图/GIF:车机屏桌面 · 导航活地图 · 天气逐时卡 · AI 绘本 -->

## 快速开始

```bash
npm install
cp .env.local.example .env.local   # 填入你自己的 Key（见文件内注释）
npm run dev                        # → http://localhost:5173
```

打开控制面板 → 选模型(慢层 + 快层)→「打开车机屏」→ 对话框里说话或打字。
试试:「今天天气怎么样」「导航去春熙路」「放首歌」「给孩子讲个故事」。

最低只需一个 [OpenRouter](https://openrouter.ai) Key 即可对话与车控;导航/地图要高德 Key,天气(Open-Meteo)、音乐(iTunes)、电台(Radio Browser)零 Key。

```bash
npm test               # 1138 个测试，全绿才算完成
npx tsc --noEmit       # 类型检查
npm run pilot [场景id] # 自动化体验闭环（消耗真实 API 额度，不进 npm test）
node build-single.mjs  # 单文件版 → single/（双击可开；注意读不到 .env，Key 相关能力不可用）
```

## 它是什么

一个把「Agent 座舱」该有的机制都搭好了的沙盒:

- **桌面 = f(车辆状态)**:卡片桌面(12×8 栅格、14 种形状)由声明式规则驱动,布局仲裁、抢占、等位区、布局重力全在机制里,模型零参与
- **Tools = 机制,Agent = 策略**:67 个 Tool / 105 条信号,信号命名对齐 COVESA VSS v6.0,确认流对齐 MCP MRTR;权限分黑/灰/彩三级,危险操作二次确认
- **快慢双层 pipeline**:快层小模型先斩后奏(车控毫秒级),慢层大模型校验接力;barge-in 世代戳、子 Agent 委托、异步记忆压缩
- **真实内容域**:高德导航(活地图/多路线/沿途搜索)、Open-Meteo 逐时天气、iTunes 音乐、Radio Browser 电台、NewsAPI 新闻、Pexels 短视频
- **AI 儿童有声绘本**:孩子照片 → 动漫定妆 → 共创式讲故事(每章问孩子"后面会发生什么")→ 导出自包含 H5
- **四条硬约束**:零后端 · 加能力=加数据不加代码 · 代码里不许有意图分支 · 运行时依赖为零(仅 vite/vitest/typescript 三个 devDependency)

架构细节、预算纪律、实拍踩坑记录见 [CLAUDE.md](CLAUDE.md)(它同时是 AI 协作的工作手册),设计文档见 [docs/](docs/)。

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

所有 Key 都写在本地 `.env.local`(已 gitignore)或控制面板里,**零后端,不经过任何中间服务器**。

## 隐私须知(绘本功能)

「路上的故事」会把**儿童照片发给第三方图像模型**(OpenRouter)用于生成动漫形象。项目本身不存储任何照片(没有后端;`public/hero/` 已整体 gitignore),但部署/演示给他人前请确认监护人知情同意——界面里的授权勾选是一次性明确动作,不是默认开关。

## 明确不做

后端 · 数据库 · 多屏 · 日夜切换 · CAN 报文级仿真 · 偏好自动学习(显式记忆是数据,自动学习是策略)。完整清单见 CLAUDE.md。

## License

[MIT](LICENSE)。第三方服务各有条款,见上表。
