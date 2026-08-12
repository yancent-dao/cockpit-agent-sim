import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
let desk: ReturnType<typeof createDesk>

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk()
  reg = createRegistry(store, TOOLS, Date.now, { desk })
})

/** 正在放着东西的状态 */
const playing = (source = 'music') => {
  store.setDirect('media.source', source)
  store.setDirect('media.track', '晴天')
  store.setDirect('media.artist', '周杰伦')
  store.setDirect('media.streamUrl', 'https://example.com/a.m4a')
  store.setDirect('media.playing', true)
}

/**
 * 传输控制不认内容源——不管在放音乐、电台还是视频，
 * 「暂停」「音量」都是同一套动作。对标 MediaSession / MPRemoteCommandCenter。
 */
describe('media.control：内容源无关的传输控制', () => {
  it('暂停与继续', async () => {
    playing()
    expect((await reg.invoke('media.control', { action: 'pause' })).status).toBe('ok')
    expect(store.get('media.playing')).toBe(false)
    expect((await reg.invoke('media.control', { action: 'play' })).status).toBe('ok')
    expect(store.get('media.playing')).toBe(true)
  })

  it('停止会清空正在播的内容，不只是暂停', async () => {
    playing()
    await reg.invoke('media.control', { action: 'stop' })
    expect(store.get('media.playing')).toBe(false)
    expect(store.get('media.streamUrl')).toBe('')
    expect(store.get('media.source')).toBe('none')
  })

  it('什么都没放的时候按暂停，说清楚而不是假装成功', async () => {
    const r = await reg.invoke('media.control', { action: 'pause' })
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('NOTHING_PLAYING')
    expect(r.message).toBeTruthy()
  })

  // 电台是直播流，没有"下一首"
  it('电台不支持切换上下首，给的是人话原因', async () => {
    playing('radio')
    const r = await reg.invoke('media.control', { action: 'next' })
    expect(r.status).toBe('rejected')
    expect(r.message).toContain('电台')
    expect(r.suggestion).toBeTruthy()
  })
})

describe('media.volume', () => {
  it('设绝对值', async () => {
    await reg.invoke('media.volume', { level: 70 })
    expect(store.get('media.volume')).toBe(70)
  })

  it('相对调节：「大声点」不需要知道当前是多少', async () => {
    store.setDirect('media.volume', 40)
    await reg.invoke('media.volume', { delta: 15 })
    expect(store.get('media.volume')).toBe(55)
  })

  it('调过头自动夹在范围内，不报错', async () => {
    store.setDirect('media.volume', 95)
    const r = await reg.invoke('media.volume', { delta: 20 })
    expect(r.status).toBe('ok')
    expect(store.get('media.volume')).toBe(100)
  })
})

describe('media.mode', () => {
  it('切随机播放', async () => {
    await reg.invoke('media.mode', { mode: 'shuffle' })
    expect(store.get('media.mode')).toBe('shuffle')
  })

  // 电台没有播放模式可言
  it('电台下切模式被拒', async () => {
    playing('radio')
    expect((await reg.invoke('media.mode', { mode: 'shuffle' })).status).toBe('rejected')
  })
})

describe('media.favorite / favorites：跨源统一的收藏', () => {
  it('收藏当前内容，歌和电台共用一份', async () => {
    playing('music')
    expect((await reg.invoke('media.favorite', {})).status).toBe('ok')
    playing('radio')
    store.setDirect('media.track', '中国之声')
    store.setDirect('media.streamUrl', 'https://example.com/cnr.mp3')
    await reg.invoke('media.favorite', {})
    const r = await reg.invoke('media.favorites', {})
    const items = (r.data as any).items
    expect(items).toHaveLength(2)
    expect(items.map((i: any) => i.source)).toEqual(['music', 'radio'])
  })

  it('收藏列表自动上屏，用户能说"放第二个"', async () => {
    playing()
    await reg.invoke('media.favorite', {})
    await reg.invoke('media.favorites', {})
    const card = desk.layout().cards.find(c => c.template === 'list')!
    expect(card).toBeTruthy()
    expect(card.data.items[0].label).toContain('晴天')
  })

  it('什么都没放时收藏不了', async () => {
    expect((await reg.invoke('media.favorite', {})).code).toBe('NOTHING_PLAYING')
  })

  it('同一个内容不会被收藏两次', async () => {
    playing()
    await reg.invoke('media.favorite', {})
    await reg.invoke('media.favorite', {})
    expect(((await reg.invoke('media.favorites', {})).data as any).items).toHaveLength(1)
  })
})
