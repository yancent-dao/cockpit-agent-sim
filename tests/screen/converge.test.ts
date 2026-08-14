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
    const id = d.show({ template: 'weather', size: 'wide', ttl: 'untilDismissed',
      data: { title: '天气', now: { temperature: 30, weather: '晴' } } }).cardId!
    const hits: string[] = []
    d.onDataChange(cid => hits.push(cid))
    d.update(id, { now: { temperature: 31, weather: '晴' } })
    expect(hits).toEqual([id])
  })

  it('一模一样的数据重刷不触发——车窗过渡每帧 render 不能闪个不停', () => {
    const d = createDesk()
    const id = d.show({ template: 'weather', size: 'wide', ttl: 'untilDismissed',
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

/** 逆地理全称"四川省成都市青羊区"当卡片标题太长（用户实拍）——截到最末两级 */
describe('shortPlace：地名截短', () => {
  it('去省级前缀，保留市+区', async () => {
    const { shortPlace } = await import('../../src/text')
    expect(shortPlace('四川省成都市青羊区')).toBe('成都市青羊区')
    expect(shortPlace('北京市朝阳区')).toBe('北京市朝阳区')
    expect(shortPlace('内蒙古自治区阿拉善盟阿拉善左旗')).toBe('阿拉善盟阿拉善左旗')
    expect(shortPlace('拉萨市')).toBe('拉萨市')
    expect(shortPlace('')).toBe('')
  })
})

/**
 * 单写者选举：同时开两个控制面板，两份桌面（卡片 id 不同）轮流推送，
 * 车机屏每两秒全量拆建——卡片集体闪、音乐 stop/重播，与是否在播放无关
 * （用户实拍的最后真凶）。规则：新开的面板接管，旧的静默让位；
 * 用户在旧面板一开口即夺回。
 */
describe('控制面板单写者选举', () => {
  it('对方更晚启动 → 我让位', async () => {
    const { yieldsTo } = await import('../../src/director/election')
    expect(yieldsTo({ src: 'a', boot: 100 }, { src: 'b', boot: 200 })).toBe(true)
    expect(yieldsTo({ src: 'a', boot: 200 }, { src: 'b', boot: 100 })).toBe(false)
  })

  it('同毫秒启动用 src 决胜——两边必须裁出唯一赢家', async () => {
    const { yieldsTo } = await import('../../src/director/election')
    const a = { src: 'aaa', boot: 100 }, b = { src: 'bbb', boot: 100 }
    expect(yieldsTo(a, b) !== yieldsTo(b, a)).toBe(true)
  })

  it('自己的消息不触发让位', async () => {
    const { yieldsTo } = await import('../../src/director/election')
    expect(yieldsTo({ src: 'a', boot: 100 }, { src: 'a', boot: 100 })).toBe(false)
  })
})
