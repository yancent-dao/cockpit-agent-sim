import { describe, it, expect } from 'vitest'
import { URGENCY, KIND_WEIGHT, priorityOf, minTierFor, evictableAt, channelOf, normalizeUrgency }
  from '../../src/config/priority'

/**
 * 来源 ≠ 紧急度。
 *
 * 老的 `PRIORITY = {task:2, rule:3, system:4}` 描述的是**谁建的卡**。
 * 后果：车门没关且已起步的安全告警，跟天气卡同为 rule，抢位时按 LRU 决定谁活 —— 错的。
 * urgency 是**正交**维度：同一个 kind 下，安全告警和背景信息该有完全不同的命运。
 */
describe('urgency 是正交维度，不是 kind 的别名', () => {
  it('四档齐全', () => {
    for (const u of ['ambient', 'normal', 'urgent', 'critical'])
      expect(URGENCY[u], u).toBeGreaterThanOrEqual(0)
  })

  it('从低到高严格递增', () => {
    const seq = ['ambient', 'normal', 'urgent', 'critical'].map(u => URGENCY[u])
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThan(seq[i - 1])
  })

  it('没声明就是 normal —— 绝大多数卡不该被迫做这个决定', () => {
    expect(normalizeUrgency(undefined)).toBe('normal')
    expect(normalizeUrgency('胡写的')).toBe('normal')
    expect(normalizeUrgency('critical')).toBe('critical')
  })

  /**
   * 这是整条改动的验收点：一张 task 的 critical 卡必须压过一张 system 的 ambient 卡。
   * 如果 kind 权重拉得太开，urgency 就成了摆设。
   */
  it('紧急度压得过来源：task+critical > system+ambient', () => {
    expect(priorityOf('task', 'critical')).toBeGreaterThan(priorityOf('system', 'ambient'))
  })

  it('同紧急度时才轮到来源说话', () => {
    expect(priorityOf('system', 'normal')).toBeGreaterThan(priorityOf('task', 'normal'))
    expect(priorityOf('rule', 'normal')).toBeGreaterThan(priorityOf('task', 'normal'))
  })
})

describe('urgency 决定能不能被挤、能缩到多小', () => {
  it('critical 和 urgent 不可挤 —— 安全告警被 LRU 挤掉是事故', () => {
    expect(evictableAt('critical')).toBe(false)
    expect(evictableAt('urgent')).toBe(false)
  })

  it('ambient 和 normal 可挤', () => {
    expect(evictableAt('ambient')).toBe(true)
    expect(evictableAt('normal')).toBe(true)
  })

  // 缩到 chip 只剩一个标题，安全告警缩成那样等于没显示
  it('critical 最小 panel，urgent 最小 card，其余可以缩到底', () => {
    expect(minTierFor('critical')).toBe('panel')
    expect(minTierFor('urgent')).toBe('card')
    expect(minTierFor('normal')).toBe('chip')
    expect(minTierFor('ambient')).toBe('chip')
  })
})

/**
 * 诊断 6：拒绝原因、约束不满足、能力缺失、卡片被挤出的告知，
 * 现在全靠往桌面塞一张卡 —— 一条一句话的提示占掉 1/6 桌面，
 * 而且跟正经内容卡长得一样，用户分不出「这是结果」还是「这是解释」。
 */
describe('三条通道：卡片 / 横幅 / 覆盖层', () => {
  it('常态内容走卡片', () => {
    expect(channelOf({ urgency: 'normal' })).toBe('card')
    expect(channelOf({ urgency: 'ambient' })).toBe('card')
  })

  it('安全告警走覆盖层 —— 它必须盖住一切', () => {
    expect(channelOf({ urgency: 'critical' })).toBe('overlay')
  })

  // 一句话的解释不该占掉桌面 1/6，也不该跟内容卡长得一样
  it('拒绝与约束不满足走横幅，不进桌面', () => {
    expect(channelOf({ kind: 'notice', reason: 'rejected' })).toBe('banner')
    expect(channelOf({ reason: 'evicted' })).toBe('banner')
    expect(channelOf({ reason: 'constraint' })).toBe('banner')
  })

  it('full 档的内容卡走覆盖层，桌面装不下它', () => {
    expect(channelOf({ size: 'full' })).toBe('overlay')
    expect(channelOf({ size: '2/3' })).toBe('card')
  })

  it('没给任何线索就走卡片 —— 默认不该是抢屏的那个', () => {
    expect(channelOf({})).toBe('card')
  })
})

describe('kind 权重表还在，只是不再单独说了算', () => {
  it('system > rule > task', () => {
    expect(KIND_WEIGHT.system).toBeGreaterThan(KIND_WEIGHT.rule)
    expect(KIND_WEIGHT.rule).toBeGreaterThan(KIND_WEIGHT.task)
  })
})
