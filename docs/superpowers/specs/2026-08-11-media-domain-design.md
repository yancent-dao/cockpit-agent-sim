# 媒体域设计：音乐 · 电台 · 新闻 · 联网搜索 · 短视频

> 2026-08-11 · 横跨信号 / Tool / 卡片 / bus / UI 五层，不留档以后没人能还原为什么这么定
> 前置：[卡片编排](./2026-08-10-card-orchestration-design.md) · [尺寸自适应](./2026-08-11-card-size-adaptive-design.md)

## CP 选型（已实测，不是查文档得来的）

零后端有两道门槛淘汰掉了大部分候选：**跨域**（请求从浏览器发）和 **Key 暴露**（前端 Key 谁都看得见，只能选泄露了不心疼的）。

| 域 | CP | 注册 | 实测结论 |
|---|---|---|---|
| 音乐 | iTunes Search | 不用 | **不支持 CORS，靠 JSONP**（`callback=`，Apple 官方文档就是这么教的）。30 秒预览直链，限流约 20 次/分 |
| 电台 | Radio Browser | 不用 | 原生 CORS + HTTPS，5 万+ 台，自动解析 M3U/PLS 和 301 |
| 新闻 | NewsAPI | 免费 Key | 浏览器直连 200 OK。**两个落差见下** |
| 联网搜索 | OpenRouter `:online` | 复用现有 | 搜索类 API（Tavily/Brave/Serper）**故意关 CORS** 防 Key 泄露，绕不过去；OpenRouter 这条通道项目已经在用 |
| 短视频 | Pexels | 免费 Key | 浏览器直连 OK，国内 **360p 档 3.1 秒出首帧**，可用 |

### NewsAPI 的两个落差（选它时就认了）

1. **`country=cn` 的头条返回 0 条**，加 category 也是 0。中文只能走 `everything`+`language=zh`，源偏窄（36氪、IT之家这类科技媒体）。
   → `news.headlines` **按语言分流**：中文用 `everything` + 领域关键词 + 按时间排；英文走真 `top-headlines`。
   → 话术上不许说"这是今天的头条"，得说"我给你搜了今天的科技新闻"。诚实优先于好听。
2. **免费层 CORS 只对 localhost 开放，且明确禁止部署**（官方原话：不能用于 staging 或生产环境，包括内部使用），100 次/天。
   → 新闻是**唯一一个只在 `npm run dev` 下能演**的能力，单文件版（`file://`，origin 为 null）和任何域名部署都不行。
   → 接受这个限制先跑通链路。真要拿出去演示时换国内 CP（聚合数据/极速数据没这个限制，且有真头条），适配层已抽好，换 CP 只是重写一个 200 行以内的文件。

**没有任何个人可注册的免费 CP 能提供华语流行乐的完整播放**——版权决定的，不是技术问题。iTunes 只给 30 秒。这一条在做 Demo 脚本时就得知道。

## Tool 分层：传输控制共用，内容源各自

不管播的是音乐、电台还是短视频，"暂停""下一个""音量"是同一套动作——这正是 Android Auto MediaSession 和 CarPlay MPRemoteCommandCenter 的模型。所以不做三套播放控制。

**通用传输 `media.*`（7 个，全彩级）**：`control`(play/pause/stop/next/prev) · `volume` · `seek` · `mode`(顺序/随机/单曲) · `queue` · `favorite` · `favorites`

**内容检索（10 个）**：`music.search` `music.play` · `radio.search` `radio.play` · `news.headlines` `news.search` `news.read` · `web.search` · `video.search` `video.play`

`music.play` 与 `media.control(play)` 不重复：前者**选内容并换源**，后者**恢复当前内容**。用户说"放周杰伦"和"继续放"是两件事。

媒体域全是彩级——可逆、不涉及安全、不涉及钱。唯一的安全问题（行驶中看视频）由约束引擎处理，不是权限分级。

## HMI 卡片：新增 0 个模板

现有抽象扛得住，这是好消息：

- **搜索结果 / 歌单 / 电台列表 / 新闻列表 / 视频列表 → `list`**。全是"带序号的候选项"，跟导航候选一模一样，用户照样说"第二个"。
- **搜索答案 / 新闻正文 → `generic`**（1/2），刚做完的短文本卡放大样式正好用上。
- **正在播放 → `media`**，唯一需要扩的：`{title, artist, artwork, playing, source}`，按尺寸分档（1/6 封面+曲名，1/3 加进度，1/2 大封面，2/3 视频画面）。

**`2/3` 从"导航专属"改成"导航 + 媒体"**。两者天然互斥——行驶中禁止看视频，能看视频时导航多半已经停了。

## 状态 vs 遥测：播放进度不进 store

`position` 每秒变好几次。让它当普通信号的话，orchestrator 每秒重评规则、重刷卡片，约束引擎还要为一个没人约束的值做无谓计算。

**store 只存"在播什么"，不存"播到第几秒"**。进度条由车机屏本地渲染。判据：Agent 需要知道在放什么，不需要知道播到 1 分 23 秒；真问起来现查。

这条界线现在不划清，以后车速、转速、电流这些高频遥测都会往 store 里挤。

信号（对齐 VSS `Vehicle.Cabin.Infotainment.Media.*`）：
`media.source`(none/music/radio/video) · `media.playing` · `media.track` · `media.artist` · `media.artwork` · `media.streamUrl` · `media.volume` · `media.mode`

## bus 变双向：车机屏第一次能上报

播放器元素只能放在车机屏（放控制面板的话，投屏后声音在错误的机器上，演示当场废）。但播放会**产生状态**：加载失败、播完了、被浏览器拦了。这些必须回流。

所以 bus 从单向变双向。**边界写死：车机屏只上报设备事实（放完了 / 放不出来 / 时长是多少），不上报决定。** 这条以后容易被侵蚀。

## 自动播放：开屏点一次

Chrome 要求页面被用户交互过才允许出声。车机屏是 `window.open` 出来的被动窗口，很可能一次点击都没有——**第一首歌会被静默拒绝**，只在控制台留一句 `NotAllowedError`，看起来像功能没做好。

车机屏开屏显示一次"点击激活声音"遮罩，点完就不再出现。只打扰一次，而且对着投屏大屏点一下也符合真实车机的开机仪式感。

## 安全约束进约束引擎

- **行驶中禁播视频**：`vehicle.speed > 0` → `video.play` rejected。跟儿童锁、高速开窗限位同一套机制，加数据即可。
- **行驶中不大段显示新闻全文**：这是**显示约束**，约束引擎管的是 Tool 写入，管不到卡片渲染。走 cardRules 的 `when` 条件（data builder 能读 store），做成"行驶中新闻卡只出标题"。这是 cardRules 第一次承担安全职责。

## `web.search` 打破了 Tool 的执行模型

其它 16 个 Tool 都是「Agent 调用 → registry 发 HTTP → 返回」。`web.search` 走 OpenRouter 的 `:online`，搜索发生在**模型内部**。

三条路选第三条：
- ~~让 Agent 判断"这问题需不需要联网"~~ → 意图分支，违反硬约束
- ~~web 插件常开~~ → 每轮都可能触发计费，模型会在不需要时搜
- **做成真 Tool，实现上发一次独立的、带 `:online` 的单轮请求**，结果当返回值

对 Agent 来说就是个普通 Tool，计费只在调用时，不需要任何意图判断。

代价是新的依赖边 **`registry → llm`**。llm 本质上也是三方服务，放 `src/integrations/` 注入，跟高德同一个模式。

## 规模预算改口径

`src/integrations/` 从"总量 < 800 行"改成 **"每个三方适配 < 200 行，总量不设上限"**。

理由：三方数量是业务决定的（产品要接几个 CP），用总量卡它等于用架构预算限制产品范围，卡错了地方。而**单个适配的复杂度**是架构问题，那个该卡死——一个 CP 的适配超过 200 行，通常说明业务逻辑漏进适配层了。

按 CP 拆文件：`amap.ts` / `itunes.ts` / `radio.ts` / `pexels.ts` / `news.ts` / `websearch.ts`，handler 拆成 `navHandlers.ts` + `mediaHandlers.ts`。

## Tool 数量：33 → 50，继续全量挂载

每轮注入的 schema 从约 5000 token 涨到 7500。代价是每轮多花 2500 token，以及模型选择困难加剧。

**先不做路由**：路由会引入"模型压根看不见某个工具"的失败模式，比选择困难更难查；而且路由要么多一次模型调用、要么靠关键词匹配（后者直接违反"代码里不许有意图分支"）。

更便宜的手段是压 Tool 描述。真出问题的信号是模型开始调错工具或漏掉明明有的能力，跑批器能测出来。

## 不做

- 音效 / EQ：属于车控不属于内容，且没有真实音频链路可调
- 多音区（主驾听歌副驾看视频）：跟"明确不做多屏"冲突
- 歌词：iTunes 不返回歌词，个人可注册的合规歌词 API 基本没有。**诚实说不支持**
