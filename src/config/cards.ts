/**
 * 卡片模板清单（v0.1）
 * 多数是"能力无关"的通用形态，靠数据驱动复用，而不是一个功能一张卡。
 * 第 1 张（车控卡）和第 10 张（通用兜底卡）是关键：
 * 前者一张覆盖所有原子车控，后者保证 Agent 不会"没卡可用"。
 */
export interface CardTemplate {
  id: string
  label: string
  desc: string
  sizes: string[]
}

export const CARD_TEMPLATES: CardTemplate[] = [
  { id: 'control', label: '车控卡', sizes: ['1/6', '1/3'],
    desc: '通用车辆控制。data: {title, items:[{label, type:slider|switch|step, value, unit}]}。车窗、空调、座椅、氛围灯共用这一张。' },
  { id: 'confirm', label: '确认卡', sizes: ['1/6', '1/3'],
    desc: '二次确认。data: {title, question, options:[string]}' },
  { id: 'feedback', label: '反馈卡', sizes: ['1/6'],
    desc: '执行结果摘要。data: {title, text}' },
  { id: 'notice', label: '提示/拒绝卡', sizes: ['1/6', '1/3'],
    desc: '拒绝原因与替代方案。data: {title, text, suggestion}' },
  { id: 'list', label: '列表卡', sizes: ['1/3', '1/2'],
    desc: '搜索结果或候选项。data: {title, items:[{label, sub}]}' },
  { id: 'info', label: '信息卡', sizes: ['1/6', '1/3'],
    desc: '只读信息，如天气、车况、日程。data: {title, text}' },
  { id: 'media', label: '媒体卡', sizes: ['1/6', '1/3', '1/2'],
    desc: '播放中的内容。data: {title, artist, progress}' },
  { id: 'nav', label: '导航卡', sizes: ['1/3', '1/2', 'full'],
    desc: '导航状态。data: {title, eta, distance}' },
  { id: 'capability', label: '能力目录卡', sizes: ['full'],
    desc: '本车全部可用能力，由 Tool Registry 自动生成，不要手工填内容。' },
  { id: 'generic', label: '通用卡', sizes: ['1/6', '1/3', '1/2', 'full'],
    desc: '兜底模板。没有合适的专用模板时用它。data: {title, text, items?, actions?}' },
]

export const TEMPLATE_IDS = CARD_TEMPLATES.map(t => t.id)
