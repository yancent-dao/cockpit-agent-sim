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
 * 通用尺寸池。不声明 sizes 的模板这三档全支持。
 *
 * 不含 2/3 和 full，这两档不是"更大的尺寸"：
 * - 2/3 是 2×2 方块、左锚定，全桌面只有一个合法位置，两张必然冲突
 * - full 是整屏覆盖层，任意卡都能 full 意味着天气卡能盖住导航
 * 需要它们的模板自己在 sizes 里写出来。
 */
export const COMMON_SIZES = ['chip', 'strip', 'bar', '1/6', 'wide', '1/3', '1/2'] as const

/**
 * 放得下若干条目才有意义的模板，下限设在 `card`（老的 1/6）。
 *
 * chip 是 393×237，实测放不下一条带副标题的候选；用户被"第 4 个"点到
 * 而屏上只有三条就是事故。这靠现有的 `sizes` 机制表达，不新增字段。
 */
export const LIST_SIZES = ['1/6', 'wide', '1/3', '1/2'] as const



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
const CANVAS_ALLOWED = ['chip', 'strip', 'bar', '1/6', 'wide', '1/3', '1/2', 'tower', '2/3', 'full']
const CANVAS_SIZES = CANVAS_ALLOWED
  .map(z => { const p = pixelsOf(z); return `${z} ${p.w}×${p.h}` }).join('，')

export const CARD_TEMPLATES: CardTemplate[] = [
  { id: 'control', label: '车控卡', defaultSize: '1/6',
    desc: '通用车辆控制。data: {title, items:[{label, type:slider|switch|step, value, unit}]}。车窗、空调、座椅、氛围灯共用这一张。',
    fields: { items: { type: 'array', required: true } } },
  { id: 'confirm', label: '确认卡', defaultSize: '1/3', sizes: [...LIST_SIZES],
    desc: '二次确认。data: {title, question, options:[string]}',
    fields: { question: { type: 'string', required: true } } },
  { id: 'feedback', label: '反馈卡', defaultSize: '1/6',
    desc: '执行结果摘要。data: {title, text?}——只给 title 也可以，比如"已开窗"。',
    fields: { text: { type: 'string' } } },
  { id: 'notice', label: '提示/拒绝卡', defaultSize: '1/6',
    desc: '拒绝原因与替代方案。data: {title, text, suggestion}',
    fields: { text: { type: 'string', required: true } } },
  { id: 'list', label: '列表卡', defaultSize: '1/2', sizes: [...LIST_SIZES],
    desc: '搜索结果或候选项。data: {title, items:[{label, sub}]}',
    fields: { items: { type: 'array', required: true } } },
  { id: 'info', label: '信息卡', defaultSize: '1/6',
    desc: '只读信息，如车况、日程。data: {title, text}——text 必须是写好的一段话，不要传结构化对象进来，那样会渲染成空白。',
    fields: { text: { type: 'string', required: true } } },
  // 播放器卡由系统按 media.playing 自动出，跟导航卡一样。
  // 能用 2/3 是因为视频要大画面——它跟导航天然互斥（行驶中禁止看视频）
  { id: 'media', label: '播放器卡', defaultSize: '1/3', sizes: [...COMMON_SIZES, '2/3'], systemOnly: true,
    desc: '正在播放的内容，由系统按播放状态自动创建/刷新/撤销，不要手动建——调 music.play / radio.play / video.play 成功后它会自己出现。',
    fields: { track: { type: 'string', required: true } } },
  { id: 'weather', label: '天气卡', defaultSize: '1/6',
    desc: '天气信息。data: {title, now:{weather,temperature,wind,humidity}, forecast?:[{date,dayWeather,nightWeather,dayTemp,nightTemp}]}——now/forecast 必须原样来自 weather.query 的返回，不要自己总结改写成一段话。title 记得写清楚查的是哪，比如"成都天气"。',
    fields: { now: { type: 'object', required: true }, forecast: { type: 'array' } } },
    // 唯一能用 2/3 的：地图要大画布。可以被调小，1/3 时退成转向条小卡
  { id: 'nav', label: '导航卡', defaultSize: '2/3', sizes: [...COMMON_SIZES, '2/3'], systemOnly: true,
    desc: '导航卡由系统按导航状态自动创建/刷新/撤销，不要手动创建——调 navigation.setDestination 成功后它会自己出现在桌面左侧。',
    fields: { destination: { type: 'string', required: true } } },
    // 唯一能用 full 的：33 项能力要铺得开
  { id: 'capability', label: '能力目录卡', defaultSize: 'full', sizes: [...COMMON_SIZES, 'full'],
    desc: '本车全部可用能力。data: {title, items:[{label, desc, off}]}——items 必须原样来自 capability.list 的返回结果，不要自己总结、分类或改写内容，否则会跟实际能力对不上。',
    fields: { items: { type: 'array', required: true } } },
  /**
   * 时钟氛围卡（用户实拍反馈）：时间做背景层会从卡片缝里漏出来。
   * 做成真卡走同一套仲裁：最低优先级填充，谁来都让位，空了自己回来。
   * 时间由车机屏本地渲染——每秒变的东西不进 data（遥测边界的老规矩）。
   */
  { id: 'clock', label: '时钟卡', defaultSize: '1/3', systemOnly: true,
    desc: '空桌面的氛围填充：时间/日期/天气。系统规则驱动，不要手动创建。' },
  { id: 'generic', label: '通用卡', defaultSize: '1/3',
    desc: '兜底模板。没有合适的专用模板时用它。data: {title, text, items?, actions?}' },
  /**
   * 生成式卡。**先确认别的模板真的装不下再用它** —— 它每次长得都不一样，
   * 跟「同一场景每次演示长得一样」是正面冲突的，产品已知并接受这个代价。
   */
  { id: 'canvas', label: '生成式卡', defaultSize: '1/2', sizes: [...CANVAS_ALLOWED],
    desc: '前面那些模板都装不下时才用：你直接写 HTML/SVG 片段放进 data.html。' +
      '只有对比表、简单图表、带版式的说明这类内容值得走它——能用 list/generic 表达的就别用。' +
      'data: {title, html, text}。text 是纯文字兜底，html 被安全过滤后为空时显示它，必填。' +
      '只允许排版标签和 SVG，脚本、表单、外链、<style> 会被剥掉（屏幕不可交互，画按钮和输入框是骗用户）。' +
      '样式只能写在 style 属性里。画布不能滚动，超出部分直接裁掉，各档位的画布像素：' +
      CANVAS_SIZES + '。按这个尺寸排版，别指望滚动。',
    fields: { html: { type: 'string', required: true }, text: { type: 'string', required: true } } },
  /**
   * 可执行的生成式卡 —— 全系统唯一的容器（iframe 沙箱）。
   * 跟 canvas 的分工：静态图文走 canvas（Shadow DOM + 消毒），
   * 需要交互/动画/计算的小组件才走这（每卡一个 iframe，重但值）。
   */
  { id: 'canvas-app', label: '生成式小组件', defaultSize: '1/2', sizes: [...CANVAS_ALLOWED],
    desc: '带交互或动画的临场小组件才用它：你写完整的 HTML+CSS+JS 放进 data.html，' +
      '会在隔离沙箱里执行。能用 canvas 静态表达的就别用这个。' +
      '沙箱里没有网络（CSP 禁外呼），图片只能用 data: 内嵌。' +
      '可用 cockpit.action("用户选了什么") 把用户在组件里的操作报回来。' +
      'data: {title, html, text}。text 是纯文字兜底必填。' +
      '画布不能滚动，超出会被裁掉，各档位像素：' + CANVAS_SIZES + '。',
    fields: { html: { type: 'string', required: true }, text: { type: 'string', required: true } } },
]

export const TEMPLATE_IDS = CARD_TEMPLATES.map(t => t.id)
