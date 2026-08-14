import { describe, it, expect } from 'vitest'
import { createDesk } from '../../src/cards/desk'
import { createOrchestrator } from '../../src/cards/orchestrator'
import { createStore } from '../../src/core/store'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { CARD_RULES, type CardRule } from '../../src/config/cardRules'

/**
 * 公理 3：降级与恢复必须对称。
 *
 * 实测取证过的两个断裂：天气卡被压到 chip 后清空桌面 5/6 它永远停在 chip；
 * 播放器被挤掉后 media.playing 仍为 true 却再也回不来——桌面成了
 * f(状态, 历史路径)，违反"桌面 = f(车辆状态)"。
 *
 * reconcile 三步：规则卡补回（立即）→ 尺寸回落（2s 迟滞防抖）→ 位置归位。
 * 恢复静默进行：挤出打扰了用户所以要告知，恢复不是打扰。
 */

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ label: 'x' + i }))

/**
 * 2026-08-14 **设计决策变更**：这一组原来断言的是"中间的卡撤走，其余卡
 * 留在原位不重新发牌"。实拍反馈推翻了它 ——「整体的卡片布局看起来太散了，
 * 没有一定的逻辑，缩小左边的卡片的时候应该向左上重新布局」。
 *
 * 位置粘性保留（第一趟），但**后面加了一趟紧凑化**：卡片只往更左上流，
 * 空白聚到右下角。新的保证比"什么都不动"更强也更有用：
 * 移动方向唯一、结果确定、只在真有洞时发生。
 */
describe('位置粘性 + 重力：布局对时间序列稳定，且不留中间的洞', () => {
  it('中间的卡撤走，后面的往左上流来补', () => {
    let now = 0
    const d = createDesk(() => now)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) { now += 10; ids.push(d.show({ template: 'feedback', size: 'box', ttl: 'untilDismissed', data: { title: '卡' + i, text: 'x' } }).cardId!) }
    const before = Object.fromEntries(d.layout().cards.map(c => [c.data.title, `${c.row},${c.col}`]))
    d.dismiss(ids[1])
    const after = Object.fromEntries(d.layout().cards.map(c => [c.data.title, `${c.row},${c.col}`]))
    expect(after['卡0'], '第一张本来就在最前，不动').toBe(before['卡0'])
    expect(after['卡2'], '卡2 补进卡1 让出的位置').toBe(before['卡1'])
  })

  it('新卡来了填空位，不把老卡挪走', () => {
    let now = 0
    const d = createDesk(() => now)
    now += 10; d.show({ template: 'feedback', size: 'box', ttl: 'untilDismissed', data: { title: 'A', text: 'x' } })
    now += 10; const b = d.show({ template: 'feedback', size: 'box', ttl: 'untilDismissed', data: { title: 'B', text: 'x' } }).cardId!
    now += 10; d.show({ template: 'feedback', size: 'box', ttl: 'untilDismissed', data: { title: 'C', text: 'x' } })
    const posC = d.layout().cards.find(c => c.data.title === 'C')!
    d.dismiss(b)
    now += 10; d.show({ template: 'feedback', size: 'box', ttl: 'untilDismissed', data: { title: 'D', text: 'x' } })
    const afterC = d.layout().cards.find(c => c.data.title === 'C')!
    expect(`${afterC.row},${afterC.col}`).toBe(`${posC.row},${posC.col}`)
  })
})

describe('尺寸回落：压力消失后回到该有的大小', () => {
  const squeeze = (d: ReturnType<typeof createDesk>, tick: () => void) => {
    // 用五张 1/3 的填充卡把天气压小
    const ids: string[] = []
    for (let i = 0; i < 5; i++) { tick(); ids.push(d.show({ template: 'feedback', size: 'box', ttl: 'untilDismissed', data: { title: '填' + i, text: 'x' } }).cardId!) }
    return ids
  }

  it('压缩 → 释放 → 2 秒后回到建议尺寸；2 秒内不动（防抖）', () => {
    let now = 0
    const d = createDesk(() => now)
    d.show({ template: 'weather', size: 'band', ttl: 'untilDismissed', data: { title: '天气', now: { temperature: 25, weather: '晴' } } })
    const ids = squeeze(d, () => { now += 10 })
    const pressed = d.layout().cards.find(c => c.data.title === '天气')!.size
    expect(d.cellsOf(pressed)).toBeLessThan(d.cellsOf('band'))
    for (const id of ids) d.dismiss(id)
    now += 500; d.tick()
    expect(d.layout().cards.find(c => c.data.title === '天气')!.size, '半秒内不该弹').toBe(pressed)
    now += 2000; d.tick()
    expect(d.layout().cards.find(c => c.data.title === '天气')!.size, '2 秒后回落').toBe('band')
  })

  it('用户显式调过的尺寸，回落目标是用户的选择', () => {
    let now = 0
    const d = createDesk(() => now)
    const id = d.show({ template: 'list', size: 'box', ttl: 'untilDismissed', data: { title: '候选', items: items(3) } }).cardId!
    d.resize(id, 'court', true)   // 用户说"放大点"
    const ids = squeeze(d, () => { now += 10 })
    for (const x of ids) d.dismiss(x)
    now += 2500; d.tick()
    expect(d.layout().cards.find(c => c.id === id)!.size, '回到用户要的 court').toBe('court')
  })

  it('恢复静默：回落不产生挤出告知', () => {
    let now = 0
    const notices: string[] = []
    const d = createDesk(() => now)
    d.onNotice(n => notices.push(n.note))
    d.show({ template: 'weather', size: 'band', ttl: 'untilDismissed', data: { title: '天气', now: { temperature: 25, weather: '晴' } } })
    const ids = squeeze(d, () => { now += 10 })
    for (const x of ids) d.dismiss(x)
    const beforeCount = notices.length
    now += 2500; d.tick()
    expect(notices.length, '恢复不是打扰').toBe(beforeCount)
  })
})

describe('规则卡补回：桌面回到 f(车辆状态)', () => {
  const RULES: CardRule[] = [{
    id: 'p', when: [['media.playing', '==', true]], watch: ['media.track'],
    card: { key: 'player', template: 'media', data: 'playerCard' },
  }]
  const boot = () => {
    let now = 0
    const store = createStore(SIGNALS, CONSTRAINTS)
    const desk = createDesk(() => now)
    createOrchestrator({ store, desk, rules: RULES, builders: { playerCard: () => ({ title: '正在播放' }) }, deps: { store } }).start()
    return { store, desk, tick: (ms: number) => { now += ms } }
  }
  /** 把桌面填死，逼规则卡被挤出 */
  const flood = (desk: any, tick: (ms: number) => void) => {
    const ids: string[] = []
    for (let i = 0; i < 24; i++) { tick(10); ids.push(desk.show({ template: 'feedback', size: 'chip', minSize: 'chip', kind: 'system', ttl: 'untilDismissed', data: { title: '填' + i, text: 'x' } }).cardId!) }
    return ids
  }

  it('播放器被挤掉后，空间一释放自动回来——歌还在放，屏上就该有它', () => {
    const { store, desk, tick } = boot()
    store.setDirect('media.playing', true)
    store.setDirect('media.track', '晴天')
    expect(desk.findByKey('player'), '规则建卡').toBeTruthy()
    const ids = flood(desk, tick)
    // 被挤出 ≠ 消失（2026-08-13）：findByKey 台上台下都认得到，这正是它
    // 数据不丢的原因——断言改成"不在台上"，不是"找不到"
    expect(desk.layout().cards.some(c => c.key === 'player'), '被挤出台面').toBe(false)
    expect(desk.findByKey('player'), '但还在——排在等位区').toBeTruthy()
    for (const id of ids.slice(0, 8)) desk.dismiss(id)
    expect(desk.findByKey('player'), '空间释放后补回').toBeTruthy()
    expect(desk.layout().cards.some(c => c.key === 'player'), '而且回到台上了').toBe(true)
  })

  it('用户亲手关掉的规则卡不许立刻诈尸——直到信号再变', () => {
    const { store, desk } = boot()
    store.setDirect('media.playing', true)
    store.setDirect('media.track', '晴天')
    const id = desk.findByKey('player')!.id
    desk.dismiss(id, { byUser: true })
    expect(desk.findByKey('player'), '用户关掉就是关掉').toBeUndefined()
    // 别的卡进出引起的 desk 变化也不触发诈尸
    const x = desk.show({ template: 'feedback', size: 'box', ttl: 'untilDismissed', data: { title: 'x', text: 'x' } }).cardId!
    desk.dismiss(x)
    expect(desk.findByKey('player'), '仍然不回来').toBeUndefined()
    // 换了首歌（watch 信号变化）→ 规则重新断言 → 回来
    store.setDirect('media.track', '成都')
    expect(desk.findByKey('player'), '信号再变才回来').toBeTruthy()
  })
})

describe('播放器卡：暂停留卡，停止退卡（用户实拍 bug）', () => {
  const RULES2: CardRule[] = CARD_RULES.filter(r => r.id.startsWith('media-playing'))

  const boot2 = () => {
    const store = createStore(SIGNALS, CONSTRAINTS)
    const desk = createDesk()
    createOrchestrator({ store, desk, rules: RULES2,
      builders: { playerCard: () => ({ title: '正在播放' }) }, deps: { store } }).start()
    return { store, desk }
  }

  it('暂停后卡还在——用户要看着 ▶ 才知道能继续', () => {
    const { store, desk } = boot2()
    store.setDirect('media.source', 'music')
    store.setDirect('media.playing', true)
    store.setDirect('media.track', '晴天')
    expect(desk.findByKey('player')).toBeTruthy()
    store.setDirect('media.playing', false)   // 暂停
    expect(desk.findByKey('player'), '暂停不是退场理由').toBeTruthy()
  })

  it('stop 清掉内容（source=none）→ 卡退场', () => {
    const { store, desk } = boot2()
    store.setDirect('media.source', 'music')
    store.setDirect('media.playing', true)
    store.setDirect('media.track', '晴天')
    store.setDirect('media.playing', false)
    store.setDirect('media.source', 'none')
    expect(desk.findByKey('player')).toBeUndefined()
  })
})
