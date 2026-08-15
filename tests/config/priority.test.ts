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
    expect(channelOf({ size: 'stage' })).toBe('card')
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

/**
 * ══════════ 回执走横幅，不占桌面 ══════════
 *
 * 产品判断（2026-08-14）：「开车窗、开空调这种显示状态的卡片应当是通知，
 * 不是卡片吧」。对 —— 而且判据早就写在三通道那段里：
 * 横幅装的是**对某个动作的解释**，卡片装内容。
 * "已开窗"是回执不是内容：看一眼就完了，之后没有任何价值。
 *
 * 查下来还有两条加重的事实：
 *   · 车控卡的交互声明**只有滑走/缩放/关闭** —— 滑块是画给人看的，点不了，
 *     所以它连"可调面板"都不是，纯回执
 *   · 它的 ttl 不填 = untilDismissed，**永不自动消失**，一直占着位置
 *
 * `ack` 跟 `reason` 是同一类字段：都是**对某个动作的元信息**
 * （为什么没做成 / 做成了没有），不是内容本身。判据仍然只看卡片自己的字段。
 */
describe('回执通道', () => {
  it('标了 ack 的走横幅', () => {
    expect(channelOf({ ack: true } as any)).toBe('banner')
  })

  it('没标的照旧进桌面', () => {
    expect(channelOf({})).toBe('card')
  })

  /**
   * **安全压过一切。** 车门没关且已起步是 critical，就算某天有人给它标了 ack，
   * 也必须上覆盖层 —— 回执可以错过，安全告警不能。
   */
  it('critical 压过 ack —— 安全告警不许降级成一条横幅', () => {
    expect(channelOf({ ack: true, urgency: 'critical' } as any)).toBe('overlay')
  })

  /** urgent 是"等着用户回应/持续要盯着"，跟"一次性回执"本来就矛盾，但真撞上时以 ack 为准 */
  it('urgent + ack 仍走横幅 —— 标了 ack 就是明说了它是回执', () => {
    expect(channelOf({ ack: true, urgency: 'urgent' } as any)).toBe('banner')
  })
})
