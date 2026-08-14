/**
 * 模型视角生成器 —— desk.summary() 的实现体。
 *
 * 它决定模型看到什么世界，重要性不亚于 Prompt，值得独立成模块
 * （设计 §7 的既定拆分：desk 回到纯几何 + 仲裁）。
 * 输入是 layout() 的结果，纯函数，随便测。
 */
import { CARD_TEMPLATES } from '../config/cards'
import { formOf } from '../config/forms'
import { dimsOf, cellsOfTier } from '../config/grid'
import type { Card, PlacedCard } from './desk'

export const titleOf = (c: Card) =>
  c.data?.title ?? CARD_TEMPLATES.find(t => t.id === c.template)?.label ?? c.template

export function summarize(l: { cards: PlacedCard[]; free: number; overlay?: Card; staged?: Card[] }): string {
  const lines: string[] = []
  if (l.overlay) lines.push(`全屏卡：${titleOf(l.overlay)}（占据整屏，关闭后自动还原）`)
  // 摘要是给**模型**看的。48 单元下说"剩余 16 格"它没法换算成
  // "还能不能再上一张卡"，只会瞎猜。按基准卡（1/6）张数说人话
  const slots = Math.floor(l.free / cellsOfTier('1/6'))
  const room = slots > 0 ? `还放得下 ${slots} 张小卡` : `已经放满了，再上卡就得收起一张`
  lines.push(l.cards.length
    ? `桌面卡片：${l.cards.map(c => `${titleOf(c)}(${c.size})`).join('、')}，${room}`
    : `桌面为空，${room}`)
  // 截断信息必须回给 Agent。只做 UI 的话模型以为屏上有 12 条、
  // 张口就说"第 10 个"，而用户根本看不到第 5 条之后的东西
  for (const c of l.cards) {
    // 可见条数由**形态函数**给——跟车机屏画的是同一个数（公理 2：
    // 世界观由结构保证）。listCapacity 自行重算的年代出过 12 vs 4 的分裂
    const total = Array.isArray(c.data?.items) ? c.data.items.length : 0
    const visible = formOf(c.template, ...dimsOf(c.size)).maxItems ?? total
    const n = Number(c.data?.moreCount ?? Math.max(0, total - visible))
    if (n > 0) lines.push(`「${titleOf(c)}」屏上只显示了前 ${total - n} 条，还有 ${n} 条没显示——别提没显示的那些`)
  }
  // 等位区（2026-08-13）：模型必须知道台下还有什么，否则会当成"没了"重新建卡，
  // 或者对着已经查过的东西说"我再帮你查查"。没有排队的东西不提这茬
  if (l.staged?.length)
    lines.push(`台下排队等桌面腾地方：${l.staged.map(titleOf).join('、')}（不是没了，有空位自动显示，或说"看XX"叫回）`)
  return lines.join('\n')
}
