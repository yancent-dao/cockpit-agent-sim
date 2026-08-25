import { pixelsOf } from './grid'
/**
 * 卡片模板清单（v0.1）
 * 多数是"能力无关"的通用形态，靠数据驱动复用，而不是一个功能一张卡。
 * 第 1 张（车控卡）和第 10 张（通用兜底卡）是关键：
 * 前者一张覆盖所有原子车控，后者保证 Agent 不会"没卡可用"。
 */
export interface FieldSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  required?: boolean
}

/**
 * 通用形状池。不声明 sizes 的模板这三档全支持——**最小·中间·最大**，
 * 不多不少（2026-08-13 实拍反馈：档位太多，用户只需要三档）。
 *
 * 更细的中间档从默认池里退场：天气/反馈类在那些档上跟 box 内容完全一样，
 * 多出来的档位只是"看起来选项更多"，对用户没有实际区别。chip 保留——
 * 它是"还想留着但没地方"的极限小档，桌面拥挤时靠它才挤得下更多卡片。
 *
 * 不含 stage 和 full，这两个不是"更大的尺寸"：
 * - stage 8×8 左锚定，全桌面只有一个合法位置，两张必然冲突
 * - full 是整屏覆盖层，任意卡都能 full 意味着天气卡能盖住导航
 * 需要它们的模板自己在 sizes 里写出来。
 */
export const COMMON_SIZES = ['chip', 'box', 'wide'] as const

/**
 * 条目流模板的形状池 —— **全是竖的**（2026-08-14 实拍反馈：
 * "列表类的内容最好使用竖的卡片，不要使用很长的横向卡，比例很不协调"）。
 *
 * 原来最大档是 12×4 的通栏横条，16 条铺 4 栏，每条 600px 宽却只有 100px 高；
 * 而且横向多栏的编号列表反而更难扫，眼睛要在四列之间来回跳。
 * **列表的阅读方向本来就是从上往下** —— 阅读方向决定卡片的长轴。
 *
 * chip/tile 不进池：335px 宽放不下一条带副标题的候选，用户被"第 4 个"
 * 点到而屏上只有三条就是事故。三档踩着分栏阈值（1 栏 → 1 栏更长 → 2 栏）。
 */
export const LIST_SIZES = ['box', 'tower', 'court'] as const



export interface CardTemplate {
  id: string
  label: string
  desc: string
  /** 首次出现时用哪个尺寸。之后用户显式改过就听用户的（见 desk 的 sizeLocked） */
  defaultSize: string
  /** 可选：收窄或放宽可用尺寸。不写 = COMMON_SIZES */
  sizes?: string[]
  /**
   * 只能由系统（规则或 Tool）创建，Agent 手动 card.show 一律拒绝。
   * 导航卡是这类：它由 orchestrator 按车辆状态驱动，Agent 自己建会出现两张，
   * 而且数据是它编的而不是来自信号。
   */
  systemOnly?: boolean
  /**
   * 列表类：items 为空时整张卡无意义，一律拒绝建卡。
   *
   * 判断本身是卡片契约的一部分（"这里有几条东西"，0 条时这句话是假的），
   * 但以前硬编码在 desk 的 isEmptyList 里点名 list/capability——仲裁引擎
   * 不该认识具体模板名。放这里之后，新增列表类模板只要声明这一个字段。
   */
  requireItems?: boolean
  /**
   * 能不能被挤下桌。**模板特性归模板声明** —— 以前只能由调用方每次传，
   * 漏一次这张卡就会在桌面挤的时候被静默收走。导航卡和绘本卡都是这类：
   * 前者导航中被挤掉是事故，后者讲到一半被挤掉就是故事断了。
   * 不写 = 可挤（绝大多数卡的正常行为）。调用方仍可显式覆盖。
   */
  evictable?: boolean
  /**
   * data 的形状声明，供 registry 在 card.show/card.update 时做运行时校验——
   * 不声明（如 generic）就不校验。这不是通用 schema 引擎，只做一层平的
   * 必填 + 类型检查，跟 Tool 参数的 ParamDef 是同一个思路，绝不嵌套。
   */
  fields?: Record<string, FieldSpec>
}

/**
 * 各档位的画布像素，拼进生成式卡的模板描述。
 *
 * 不告诉模型画布多大它必然溢出 —— 它没有别的办法知道自己有多大。
 * 这串是**算出来的**不是写死的：改栅格或屏幕尺寸，这句话自动跟着变。
 */
/** canvas 允许的全部档位。desc 的像素契约从**同一个数组**生成——合同和门卫说同一套话 */
// 产品裁定（2026-08-13 两轮定稿）：生成式卡**不进覆盖层**（full 禁——浮在所有卡
// 上面把桌面盖死），上限 stage（走桌面仲裁）。竖向内容塞进横条就是"高度裁半、
// 右边空一片"（实拍），所以池子里横竖各留几档让模型按内容形状挑。
// 一行高的 chip/strip/bar 不进池：生成内容塞进 187px 高必然被裁
const CANVAS_ALLOWED = ['tile', 'box', 'frame', 'wide', 'panel', 'hall', 'tower', 'court', 'stage']
/**
 * 一行正文的高度（px）。canvas 的 `:host` 用 `--t-cap`（22px）× 档位系数，
 * 行高 1.4，取个偏保守的整数 —— 这是**粗估不是精算**，宁可让模型少写。
 */
const CANVAS_LINE_PX = 38
/**
 * 容量既给像素也给**行数**。
 *
 * 实拍（2026-08-14）：研究报告反复溢出，子 Agent 一轮轮砍内容 —— 它
 * **知道**自己溢出了，缺的不是"被告知要少写"，是**能对着算的容量**。
 * 「745×442」对模型没有意义（它不做排版计算），「约 11 行」它数得出来。
 * 像素留着：画 SVG、定 viewBox 要用。
 */
const CANVAS_SIZES = CANVAS_ALLOWED
  .map(z => {
    const p = pixelsOf(z)
    return `${z} ${p.w}×${p.h}（约 ${Math.max(1, Math.floor(p.h / CANVAS_LINE_PX))} 行）`
  }).join('，')

export const CARD_TEMPLATES: CardTemplate[] = [
  { id: 'control', label: '车控卡', defaultSize: 'box', sizes: ['tile', 'box', 'tower'],
    desc: '通用车辆控制。data: {title, items:[{label, type:slider|switch|step, value, unit}]}。车窗、空调、座椅、氛围灯共用这一张。',
    fields: { items: { type: 'array', required: true } } },
  { id: 'confirm', label: '确认卡', defaultSize: 'wide', sizes: ['box', 'wide'],
    desc: '二次确认。data: {title, question, options:[string]}',
    fields: { question: { type: 'string', required: true } } },
  { id: 'feedback', label: '反馈卡', defaultSize: 'box', sizes: ['chip', 'box'],
    desc: '执行结果摘要。data: {title, text?}——只给 title 也可以，比如"已开窗"。',
    fields: { text: { type: 'string' } } },
  { id: 'notice', label: '提示/拒绝卡', defaultSize: 'wide', sizes: ['tile', 'wide'],
    desc: '拒绝原因与替代方案。data: {title, text, suggestion}',
    fields: { text: { type: 'string', required: true } } },
  { id: 'list', label: '列表卡', defaultSize: 'tower', sizes: [...LIST_SIZES], requireItems: true,
    desc: '搜索结果或候选项。data: {title, items:[{label, sub}]}',
    fields: { items: { type: 'array', required: true } } },
  /**
   * 台下清单（2026-08-13 等位区 W2）：点边缘条弹出的"界面之外还有什么"。
   * systemOnly——它由机制按 desk.layout().staged 生成，模型手建的话
   * 内容是编的不是台下真实名单。条目 value 带卡 id，点击直调 card.focus 召回。
   */
  { id: 'stagedlist', label: '台下清单', defaultSize: 'tower', sizes: [...LIST_SIZES], systemOnly: true, requireItems: true,
    desc: '台下排队卡片的清单，由系统按等位区状态自动生成，不要手动建。',
    fields: { items: { type: 'array', required: true } } },
  { id: 'info', label: '信息卡', defaultSize: 'box', sizes: ['box', 'wide', 'panel'],
    desc: '只读信息，如车况、日程。data: {title, text}——text 必须是写好的一段话，不要传结构化对象进来，那样会渲染成空白。',
    fields: { text: { type: 'string', required: true } } },
  // 播放器卡由系统按 media.playing 自动出，跟导航卡一样。
  // 三档踩着 mediaForm 的真实内容阈值：box 封面+播控+进度全在，hall 多出全套
  // 播控（随机/循环/收藏/音量）与"接下来"预告，court 竖版大封面 + 完整队列。
  // 视频走 hall（1208×741，宽高比 1.63）——它跟 16:9 只差 8%，1208 宽的画面
  // 680 高，底下正好留一条 61px 的标题栏，几乎没有黑边。
  // 更大的 stage 同样是 1.63，但把它加进池子会让 court 和 stage 的形态完全相同
  // （形态函数只看几何，看不出"这是视频"），多出来的那一档就是白给。
  // 真要给视频大画面，正解是拆一个 video 模板而不是给 media 加档 —— 记在待办里
  { id: 'media', label: '播放器卡', defaultSize: 'hall', sizes: ['box', 'hall', 'court'], systemOnly: true,
    desc: '正在播放的内容，由系统按播放状态自动创建/刷新/撤销，不要手动建——调 music.play / radio.play / video.play 成功后它会自己出现。',
    fields: { track: { type: 'string', required: true } } },
  // 三档踩着 weatherForm 的真实阈值：tile 只有当前温度+今日高低、
  // wide 解锁 6 小时逐时降水条、band 到 12 小时 + 5 天。
  // **主角是逐时不是多日**（2026-08-14 调研）：车里最想知道的是
  // "接下来一两小时会不会下雨"，5 天预报是手机首页的逻辑
  { id: 'weather', label: '天气卡', defaultSize: 'wide', sizes: ['tile', 'wide', 'band'],
    desc: '天气信息。data: {title, now:{weather,temperature,wind,humidity}, forecast?:[{date,dayWeather,nightWeather,dayTemp,nightTemp}]}——now/forecast 必须原样来自 weather.query 的返回，不要自己总结改写成一段话。title 记得写清楚查的是哪，比如"成都天气"。',
    fields: { now: { type: 'object', required: true }, forecast: { type: 'array' } } },
  /**
   * 导航卡三档 strip(4×2) → hall(6×6) → stage(8×8)。
   *
   * **中档必须有地图**（2026-08-14 实拍反馈："中等尺寸没有地图不合理，
   * 中间看着非常空"）。上一版中档是 tower(4×4)，只有 4 列宽，形态函数
   * 要求宽 ≥8 才画地图，于是条件永远不满足、干脆不画，留下一大片空白。
   * 换成 hall（1208×741）之后地图有 500px 高，正好是"前方一段路"的形状，
   * 而且它跟最大档 stage 宽高比相同（1.63），两档共用一套骨架。
   * 中档仍然不用扁条形状：地图往扁条里塞只会横向拉伸变形。
   */
  { id: 'nav', label: '导航卡', defaultSize: 'stage', sizes: ['strip', 'hall', 'stage'], systemOnly: true,
    desc: '导航卡由系统按导航状态自动创建/刷新/撤销，不要手动创建——调 navigation.setDestination 成功后它会自己出现在桌面左侧。',
    fields: { destination: { type: 'string', required: true } } },
  // 两档：court 双栏网格、full 铺满四栏。砍掉了最小档——用户问"你能做什么"，
  // 屏幕回答一个数字「33 项」不是答案。唯一能用 full 的：能力要铺得开
  { id: 'capability', label: '能力目录卡', defaultSize: 'full', sizes: ['court', 'full'], requireItems: true,
    desc: '本车全部可用能力。data: {title, items:[{label, desc, off}]}——items 必须原样来自 capability.list 的返回结果，不要自己总结、分类或改写内容，否则会跟实际能力对不上。',
    fields: { items: { type: 'array', required: true } } },
  /* ══════════ 2026-08-14 新增六张 ══════════
   * 判据统一是**「有真实数据源在用，且现有模板会渲染错」** ——
   * 不满足就不加，模板数量本身也是成本（时间线卡、评分卡、表单卡都想过，
   * 但列表卡加生成式卡已经能表达，且没有现成数据源在等着它们）。
   */
  /**
   * 轮播卡：带图的横向条目流。列表卡只有纯文字条目，POI 照片、专辑封面、
   * 视频缩略图、带图新闻都拿不出来。**页码是屏内展示状态不进桌面仲裁** ——
   * 每 5 秒推进一页要是走 desk，就是每 5 秒触发一次全屏重排。
   * 少数该用横卡的模板：阅读方向是横向流。
   */
  { id: 'carousel', label: '轮播卡', defaultSize: 'panel', sizes: ['panel', 'hall', 'band'],
    requireItems: true,
    desc: '带图的横向条目流。data: {title, items:[{label, sub, image?, value?}]}——' +
      '有图才用它，纯文字条目用列表卡（可预测）。',
    fields: { items: { type: 'array', required: true } } },
  /**
   * 对比卡：多路线方案**已经有 Tool 在返回数据**，但没有对应模板，
   * 现在只能塞进列表卡或者让模型现画一张生成卡 —— 后者每次长得不一样。
   * 对比是横向并列，用横卡。
   */
  { id: 'compare', label: '对比卡', defaultSize: 'panel', sizes: ['wide', 'panel'],
    desc: '几个方案并排比。data: {title, columns:[{label, badge?, rows:[{k,v,best?}]}]}',
    fields: { columns: { type: 'array', required: true } } },
  /**
   * 进展卡：后台任务现在**借用列表卡**渲染 —— 一条「正在查行情」和一条
   * 「已完成」长得完全一样，没有状态点、没有进度，用户看不出哪件事还在跑。
   * 一条条往下看，用竖卡。
   */
  { id: 'progress', label: '进展卡', defaultSize: 'box', sizes: ['box', 'tower'],
    requireItems: true,
    desc: '多件事的进展。data: {title, items:[{label, state:running|done|failed, detail?, percent?}]}',
    fields: { items: { type: 'array', required: true } } },
  /**
   * 指标卡：一个大数字 + 趋势。续航、电量、车速、今日里程 ——
   * 现在走信息卡会被渲染成一段话，而这类内容恰恰是"余光扫一眼"的典型。
   * 它是 chip / tile 两个小档真正的主人。
   */
  { id: 'metric', label: '指标卡', defaultSize: 'tile', sizes: ['chip', 'tile', 'box'],
    desc: '一个关键数值。data: {title, value, unit?, sub?, trend?, percent?}',
    fields: { value: { type: 'number', required: true } } },
  /**
   * 图表卡：声明式折线/柱状/环形，SVG 画，纯函数可测 ——
   * 生成式卡的**可预测替代**（同一场景每次演示长得一样）。
   */
  { id: 'chart', label: '图表卡', defaultSize: 'wide', sizes: ['box', 'wide', 'panel'],
    desc: '简单图表。data: {title, kind:bar|line, series:[{label,value}], unit?}',
    fields: { series: { type: 'array', required: true } } },
  /**
   * 图片卡：新档 `frame`（1.08，全表最接近正方）的主要用户 ——
   * 照片和地图缩略图本来就是方的。
   */
  { id: 'image', label: '图片卡', defaultSize: 'frame', sizes: ['box', 'frame', 'hall'],
    desc: '单张大图。data: {title, url, caption?}',
    fields: { url: { type: 'string' } } },
  /**
   * 绘本卡（2026-08-14「路上的故事」）—— 跟其它卡**不是一类东西**。
   *
   * 普通卡片是数据的一个投影，随时能被挤走、缩放、替换；绘本是一次
   * **有开始有结束的会话**，中途被挤下桌就是故事断了。所以 evictable:false，
   * 跟导航卡同级保护。
   *
   * 三档不是大小差异是**场景差异**：court 竖版、stage 行驶中给副驾看、
   * full 停车时全屏沉浸。阶段（定妆/讲述/提问/成书）由 story.phase 信号驱动，
   * 同一张卡换版式，不是四张卡。
   */
  { id: 'storybook', label: '绘本卡', defaultSize: 'stage', sizes: ['court', 'stage', 'full'],
    systemOnly: true, evictable: false,
    desc: '正在讲的绘本，由 story.* 工具自动创建与刷新，不要手动建。' +
      'data: {title, chapter, page, line, image, ideas?, lesson?}',
    fields: { line: { type: 'string', required: true } } },
  /**
   * 趋势卡（旅行助手，2026-08-20）。四类监控项（机票/酒店/汇率/新闻）共用。
   *
   * 为什么值得一张新模板：`chart` 是通用图表，而趋势卡的「历史曲线 + 预测带 +
   * 分位对照 + 提醒线 + 监控状态」是**一个语义整体**——拆到 chart + generic
   * 两张卡上，用户就得自己把"现在贵不贵"和"我设的线在哪"对起来。
   *
   * 三档是内容密度不是缩放：box 只回答"现在多少、贵不贵"；hall 加完整曲线与
   * 提醒线；stage 再加 30 天分位对照和依据——「建议必须带依据」那条要展开说。
   *
   * **verdict 由模型给，不是代码算的**：分位/极值/方向是事实（core/trend 算），
   * 买不买是策略。同 climate.set 不替用户多加两度。
   */
  { id: 'trend', label: '趋势卡', defaultSize: 'hall', sizes: ['box', 'hall', 'stage'],
    desc: '价格/汇率的走势与结论。data: {title, unit?, current, changeFromPrev?, min?, max?, ' +
      'median?, percentile?, points:[{at,value}], forecast?:[{at,value,lo?,hi?}], ' +
      'threshold?, thresholdLabel?, verdict?:{label,tone:ok|warn|info}, basis?:[一句话依据], ' +
      'monitor?:{everyLabel,expiresLabel,statusLabel}, updatedLabel?}。' +
      'verdict 是你的判断（"可以下单"），依据放 basis——没依据的建议不要给。',
    fields: { points: { type: 'array', required: true } } },
  /**
   * 融合旅行卡（2026-08-25，设计稿 artifact「旅行助手 HMI」）。
   * 一张卡 = 一次旅行在屏幕上的家：攻略（头图+行前准备+Day 轮播帧）→
   * 盯价（+机票/分段住宿价格块）→ 到价（+决策条），同 key 原地生长。
   * 三个阶段是**数据形状**不是状态机：有 days 没价格块 = 攻略；有 flight/
   * stays = 盯价；有 decide = 到价——渲染只看字段，没有 phase 枚举。
   *
   * 它吃掉了 guide 与 itinerary 两个模板：分开建卡的话"确认攻略之后"
   * 屏幕上就是两张卡讲同一次旅行，用户还得自己对齐。
   * Day 轮播是纯 CSS（keyframes 在 screen.html），零状态零计时器。
   */
  { id: 'trip', label: '旅行卡', defaultSize: 'court', sizes: ['hall', 'court', 'stage'],
    systemOnly: true,
    desc: '一次旅行的家：攻略/盯价/到价同一张卡。由 travel.* 机制生成，不手动建。',
    fields: { days: { type: 'array' } } },
  { id: 'automation', label: '自动任务卡', defaultSize: 'tower', sizes: ['box', 'tower', 'court'],
    requireItems: true,
    desc: '自动任务清单（机制生成为主）。data: {title, items:[{value:任务id, label, sub}]}，点条目=启停',
    fields: { items: { type: 'array', required: true } } },
  { id: 'generic', label: '通用卡', defaultSize: 'box', sizes: ['box', 'wide', 'panel'],
    desc: '兜底模板。没有合适的专用模板时用它。data: {title, text, items?, actions?}' },
  /**
   * 生成式卡。**先确认别的模板真的装不下再用它** —— 它每次长得都不一样，
   * 跟「同一场景每次演示长得一样」是正面冲突的，产品已知并接受这个代价。
   */
  { id: 'canvas', label: '生成式卡', defaultSize: 'wide', sizes: [...CANVAS_ALLOWED],
    desc: '**万能兜底**：凡是现有模板装不下的内容——分析报告、对比表、图表、带版式的' +
      '说明、任何需要自由排版的东西——都用它，直接写 HTML/SVG 片段放进 data.html。' +
      '判据只有一条：先看现有模板够不够用，够用就用现成的（可预测），不够就大胆用它。' +
      '**动手前先 skill.use 取「生成卡片」设计规范照着排**——不然出来就是文字墙。' +
      'data: {title, html, text}。text 是纯文字兜底，html 被安全过滤后为空时显示它，必填。' +
      '只允许排版标签和 SVG，脚本、表单、外链、<style> 会被剥掉（屏幕不可交互，画按钮和输入框是骗用户）。' +
      '样式只能写在 style 属性里。**按放得下写**——行数是硬预算，超了就得砍内容而不是缩字号。各档位容量：' +
      CANVAS_SIZES + '。按这个容量排版：写不下就砍内容、拆成两张卡（用不同的 key），别指望缩字号或滚动。',
    fields: { html: { type: 'string', required: true }, text: { type: 'string', required: true } } },
  /**
   * 可执行的生成式卡 —— 全系统唯一的容器（iframe 沙箱）。
   * 跟 canvas 的分工：静态图文走 canvas（Shadow DOM + 消毒），
   * 需要交互/动画/计算的小组件才走这（每卡一个 iframe，重但值）。
   */
  { id: 'canvas-app', label: '生成式小组件', defaultSize: 'hall', sizes: [...CANVAS_ALLOWED],
    desc: '带交互或动画的临场小组件才用它（用户张口要个计算器/换算器/小游戏/倒计时这类没有现成工具的需求，就用它现做一个，别说做不了）：你写完整的 HTML+CSS+JS 放进 data.html，**按内容形状选尺寸**（同层进桌面，绝不覆盖别的卡）：游戏/排行这类竖向内容用 court 或 tower；近正方的用 frame 或 hall；横向信息流用 wide 或 panel；小部件 tile。内容形状和卡片形状拧着来就是"裁一半+空一片"。' +
      '会在隔离沙箱里执行。能用 canvas 静态表达的就别用这个。' +
      '**排版必须跟整张桌面一体**：沙箱已带系统字体和浅色配色（文字 var(--tx-1)、底透明），' +
      '不要写 font-family、不要另起深色背景、不要用 px 自定字号——字号只用 ' +
      'var(--t-cap)/var(--t-body)/var(--t-title)/var(--t-lead)/var(--t-hero) 五档，' +
      '颜色只用 var(--tx-1/2/3) 和 var(--ac)，让内容自然撑开高度（别写 100vh）。' +
      '一会大一会小、一张黑一张白，用户一眼就看出是外来的。' +
      '沙箱里没有网络（CSP 禁外呼），图片只能用 data: 内嵌。' +
      '可用 cockpit.action("用户选了什么") 把用户在组件里的操作报回来。' +
      'data: {title, html, text}。text 是纯文字兜底必填。' +
      '**按放得下写**，行数是硬预算。各档位容量：' + CANVAS_SIZES + '。',
    fields: { html: { type: 'string', required: true }, text: { type: 'string', required: true } } },
]

export const TEMPLATE_IDS = CARD_TEMPLATES.map(t => t.id)
