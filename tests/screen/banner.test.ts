import { describe, it, expect } from 'vitest'
import { createBannerQueue, toneOf } from '../../src/screen/banner'

/**
 * 诊断 6：拒绝原因、约束不满足、能力缺失、卡片被挤出的告知，
 * 现在全靠往桌面塞一张卡 —— 一句话的提示占掉 1/6 桌面，
 * 而且跟正经内容卡长得一样，用户分不出「这是结果」还是「这是解释」。
 *
 * 横幅是第二条通道：锚定桌面区顶部，一次一条排队，不占桌面格子。
 */
describe('横幅排队：一次只显示一条', () => {
  const mk = () => {
    const shown: any[] = []
    let t = 0
    const q = createBannerQueue({
      show: b => shown.push(b),
      hide: () => shown.push(null),
      clock: () => t,
    })
    return { q, shown, tick: (ms: number) => { t += ms; q.tick() } }
  }

  it('第一条立刻显示', () => {
    const { q, shown } = mk()
    q.push({ text: '开不了，车在动' })
    expect(shown).toHaveLength(1)
    expect(shown[0].text).toBe('开不了，车在动')
  })

  it('第二条排队，不会盖掉第一条', () => {
    const { q, shown } = mk()
    q.push({ text: 'A' }); q.push({ text: 'B' })
    expect(shown).toHaveLength(1)
    expect(shown[0].text).toBe('A')
  })

  it('第一条到点退场后第二条才上', () => {
    const { q, shown, tick } = mk()
    q.push({ text: 'A', ttl: 100 }); q.push({ text: 'B' })
    tick(120)
    expect(shown.map(s => (s ? s.text : null))).toEqual(['A', null, 'B'])
  })

  it('队列空了就收起来', () => {
    const { q, shown, tick } = mk()
    q.push({ text: 'A', ttl: 100 })
    tick(120)
    expect(shown[shown.length - 1]).toBe(null)
  })

  /**
   * 同一条原因反复触发（用户连着说三次「开窗」都被同一条约束拦下）
   * 不该排三条队 —— 那会让用户等 9 秒才看到别的
   */
  it('同一条内容重复推入只留一条', () => {
    const { q, shown } = mk()
    q.push({ text: '开不了，车在动' })
    q.push({ text: '开不了，车在动' })
    q.push({ text: '开不了，车在动' })
    expect(q.pending()).toBe(0)
    expect(shown).toHaveLength(1)
  })

  // critical 是安全相关，让它在队尾等着不可接受
  it('critical 插队到最前面', () => {
    const { q, shown, tick } = mk()
    q.push({ text: 'A', ttl: 100 }); q.push({ text: 'B' }); q.push({ text: '车门没关', tone: 'danger', jump: true })
    tick(120)
    expect(shown[2].text).toBe('车门没关')
  })

  it('clear 一次收干净，切场景不留残影', () => {
    const { q, shown } = mk()
    q.push({ text: 'A' }); q.push({ text: 'B' })
    q.clear()
    expect(q.pending()).toBe(0)
    expect(shown[shown.length - 1]).toBe(null)
  })
})

/**
 * 诊断 5 的另一半：这四种现在全是橙色，用户分不出
 * 「不让做」「条件不满足」「顺手告诉你一声」「做完了」。
 */
describe('横幅按语义分色，不再全是橙', () => {
  it('拒绝是 danger，约束不满足是 warn —— 两者不是一回事', () => {
    expect(toneOf('rejected')).toBe('danger')
    expect(toneOf('constraint')).toBe('warn')
  })

  it('挤出告知和能力缺失是 info，它们不是错误', () => {
    expect(toneOf('evicted')).toBe('info')
    expect(toneOf('unsupported')).toBe('info')
  })

  it('执行完成是 ok', () => {
    expect(toneOf('done')).toBe('ok')
  })

  it('认不出的原因退到 info，不会误报成红色', () => {
    expect(toneOf('从没见过')).toBe('info')
    expect(toneOf(undefined)).toBe('info')
  })
})
