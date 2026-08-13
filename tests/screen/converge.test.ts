import { describe, it, expect } from 'vitest'
import { truncate } from '../../src/screen/render'
import { createDesk } from '../../src/cards/desk'

/** 截断三连（listBody / capability / generic 各写一遍 slice+rest）归一成一个 */
describe('truncate：一个公式管所有截断', () => {
  const items = Array.from({ length: 10 }, (_, i) => i)

  it('切前 N 条并报剩余', () => {
    const r = truncate(items, 4)
    expect(r.shown).toHaveLength(4)
    expect(r.rest).toBe(6)
  })

  it('没超不报', () => {
    expect(truncate(items.slice(0, 3), 4).rest).toBe(0)
  })

  it('上限缺省 = 不截', () => {
    expect(truncate(items, undefined).shown).toHaveLength(10)
  })
})

/**
 * diff 高亮的机制半边：同 key 更新时 desk 说得出"数据真的变了"。
 * 北京天气刷进成都那张卡时屏幕闪一下——但 ETA 每秒重刷相同值不能闪个不停。
 */
describe('desk.onDataChange：真变了才通知', () => {
  it('数据变化触发，携带卡片 id', () => {
    const d = createDesk()
    const id = d.show({ template: 'weather', size: '1/6', ttl: 'untilDismissed',
      data: { title: '天气', now: { temperature: 30, weather: '晴' } } }).cardId!
    const hits: string[] = []
    d.onDataChange(cid => hits.push(cid))
    d.update(id, { now: { temperature: 31, weather: '晴' } })
    expect(hits).toEqual([id])
  })

  it('一模一样的数据重刷不触发——车窗过渡每帧 render 不能闪个不停', () => {
    const d = createDesk()
    const id = d.show({ template: 'weather', size: '1/6', ttl: 'untilDismissed',
      data: { title: '天气', now: { temperature: 30, weather: '晴' } } }).cardId!
    const hits: string[] = []
    d.onDataChange(cid => hits.push(cid))
    d.update(id, { now: { temperature: 30, weather: '晴' } })
    expect(hits).toEqual([])
  })
})

/** 天气图标映射：展示映射不是意图分支（同 CN 枚举表待遇），纯函数配测试 */
describe('weatherIcon', () => {
  it('按现象关键词给图标，雷优先于雨', async () => {
    const { weatherIcon } = await import('../../src/screen/icons')
    expect(weatherIcon('雷阵雨')).toContain('svg')
    expect(weatherIcon('雷阵雨')).not.toBe(weatherIcon('小雨'))
    expect(weatherIcon('多云')).not.toBe(weatherIcon('晴'))
    expect(weatherIcon(undefined)).toContain('svg')   // 兜底晴天，不给空
  })
})
