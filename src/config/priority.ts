/**
 * 显示优先级与通道分派 —— 纯数据 + 查表，没有一行意图分支。
 *
 * ## 来源 ≠ 紧急度
 *
 * 老的 `PRIORITY = {task:2, rule:3, system:4}` 描述的是**谁建的卡**。
 * 后果：车门没关且已起步的安全告警，跟天气卡同为 `rule`，抢位时按 LRU 决定谁活 —— 错的。
 *
 * `urgency` 是**正交**维度：同一个 kind 下，安全告警和背景信息该有完全不同的命运。
 * 最终优先级 = kind 权重 + urgency 权重，两张表都在这里，改行为 = 改数字。
 *
 * urgency 由 `cardRules` 声明或 `card.show` 传入，默认 `normal` ——
 * 绝大多数卡不该被迫做这个决定。
 */

export type Urgency = 'ambient' | 'normal' | 'urgent' | 'critical'
export type Kind = 'task' | 'rule' | 'system'

/**
 * 紧急度权重。步长 10 而 kind 步长 1 —— 差一个数量级是刻意的：
 * 紧急度必须压得过来源，否则它就成了摆设（一张 task 的安全告警
 * 要能压过一张 system 的天气卡）。
 */
export const URGENCY: Record<string, number> = {
  ambient: 0,    // 背景信息：天气、播放器
  normal: 10,    // 常规反馈：车控、列表
  urgent: 20,    // 需要用户回应：确认、待选
  critical: 30,  // 安全相关：车门未关、约束拒绝
}

/** 来源权重。同紧急度时才轮到它说话 */
export const KIND_WEIGHT: Record<string, number> = { task: 1, rule: 2, system: 3 }

export const normalizeUrgency = (u: any): Urgency =>
  (u in URGENCY ? u : 'normal') as Urgency

export const priorityOf = (kind: string, urgency?: string) =>
  URGENCY[normalizeUrgency(urgency)] + (KIND_WEIGHT[kind] ?? 1)

/** urgent 以上不可挤 —— 安全告警被 LRU 挤掉是事故，等着用户回应的问题卡也一样 */
export const evictableAt = (urgency?: string) =>
  URGENCY[normalizeUrgency(urgency)] < URGENCY.urgent

/**
 * 能缩到多小。缩到 chip 只剩一个标题，安全告警缩成那样等于没显示，
 * 待选卡缩成那样用户就不知道有几个选项。
 */
const MIN_TIER: Record<Urgency, string> = {
  critical: 'panel', urgent: 'card', normal: 'chip', ambient: 'chip',
}
export const minTierFor = (urgency?: string) => MIN_TIER[normalizeUrgency(urgency)]

export type Channel = 'card' | 'banner' | 'overlay'

/**
 * 三条通道（诊断 6）。
 *
 * 拒绝原因、约束不满足、能力缺失、卡片被挤出的告知，现在全靠往桌面塞一张卡：
 * 一句话的提示占掉 1/6 桌面，而且跟正经内容卡长得一样，
 * 用户分不出「这是结果」还是「这是解释」。
 *
 *   卡片   常态信息与结果，48 单元桌面内，多张并存
 *   横幅   解释性内容，锚定桌面区顶部，一次一条排队
 *   覆盖层 critical 告警 / full 档内容，整屏，一次一个
 *
 * 判据全部来自卡片自己的字段，不看内容、不匹配关键词。
 */
export function channelOf(c: { urgency?: string; size?: string; reason?: string; kind?: string }): Channel {
  if (normalizeUrgency(c.urgency) === 'critical') return 'overlay'
  // reason 是「为什么会有这条消息」：被拒了、被挤了、约束不满足、能力没有。
  // 它们都是对某个动作的解释，不是内容本身
  if (c.reason) return 'banner'
  if (c.size === 'full') return 'overlay'
  return 'card'
}
