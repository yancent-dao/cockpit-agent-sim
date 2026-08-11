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

export interface CardTemplate {
  id: string
  label: string
  desc: string
  sizes: string[]
  /**
   * data 的形状声明，供 registry 在 card.show/card.update 时做运行时校验——
   * 不声明（如 generic）就不校验。这不是通用 schema 引擎，只做一层平的
   * 必填 + 类型检查，跟 Tool 参数的 ParamDef 是同一个思路，绝不嵌套。
   */
  fields?: Record<string, FieldSpec>
}

export const CARD_TEMPLATES: CardTemplate[] = [
  { id: 'control', label: '车控卡', sizes: ['1/6', '1/3'],
    desc: '通用车辆控制。data: {title, items:[{label, type:slider|switch|step, value, unit}]}。车窗、空调、座椅、氛围灯共用这一张。',
    fields: { items: { type: 'array', required: true } } },
  { id: 'confirm', label: '确认卡', sizes: ['1/6', '1/3'],
    desc: '二次确认。data: {title, question, options:[string]}',
    fields: { question: { type: 'string', required: true } } },
  { id: 'feedback', label: '反馈卡', sizes: ['1/6'],
    desc: '执行结果摘要。data: {title, text?}——只给 title 也可以，比如"已开窗"。',
    fields: { text: { type: 'string' } } },
  { id: 'notice', label: '提示/拒绝卡', sizes: ['1/6', '1/3'],
    desc: '拒绝原因与替代方案。data: {title, text, suggestion}',
    fields: { text: { type: 'string', required: true } } },
  { id: 'list', label: '列表卡', sizes: ['1/3', '1/2'],
    desc: '搜索结果或候选项。data: {title, items:[{label, sub}]}',
    fields: { items: { type: 'array', required: true } } },
  { id: 'info', label: '信息卡', sizes: ['1/6', '1/3'],
    desc: '只读信息，如车况、日程。data: {title, text}——text 必须是写好的一段话，不要传结构化对象进来，那样会渲染成空白。',
    fields: { text: { type: 'string', required: true } } },
  { id: 'media', label: '媒体卡', sizes: ['1/6', '1/3', '1/2'],
    desc: '播放中的内容。data: {title, artist, progress}' },
  { id: 'weather', label: '天气卡', sizes: ['1/6', '1/3'],
    desc: '天气信息。data: {title, now:{weather,temperature,wind,humidity}, forecast?:[{date,dayWeather,nightWeather,dayTemp,nightTemp}]}——now/forecast 必须原样来自 weather.query 的返回，不要自己总结改写成一段话。title 记得写清楚查的是哪，比如"成都天气"。',
    fields: { now: { type: 'object', required: true }, forecast: { type: 'array' } } },
  { id: 'nav', label: '导航卡', sizes: ['2/3'],
    desc: '导航卡由系统按导航状态自动创建/刷新/撤销，不要手动创建——调 navigation.setDestination 成功后它会自己出现在桌面左侧。',
    fields: { destination: { type: 'string', required: true } } },
  { id: 'capability', label: '能力目录卡', sizes: ['full'],
    desc: '本车全部可用能力。data: {title, items:[{label, desc, off}]}——items 必须原样来自 capability.list 的返回结果，不要自己总结、分类或改写内容，否则会跟实际能力对不上。',
    fields: { items: { type: 'array', required: true } } },
  { id: 'generic', label: '通用卡', sizes: ['1/6', '1/3', '1/2', 'full'],
    desc: '兜底模板。没有合适的专用模板时用它。data: {title, text, items?, actions?}' },
]

export const TEMPLATE_IDS = CARD_TEMPLATES.map(t => t.id)
