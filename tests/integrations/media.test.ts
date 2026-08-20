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

  /**
   * 实拍（2026-08-19）：放视频后说"下一个"，切回了播客界面。根因是
   * video.play 从不碰 st.queue（每次都是一次性 Pexels 搜索，没有"下一条"
   * 这个概念），而 media.control 的 next/prev 只挡了 radio，没挡 video——
   * 于是它拿着上一次播客/音乐搜索留下的**陈旧队列**当成"下一条视频"续播，
   * 界面就从视频卡跳回了播客卡。跟电台是同一类问题：不是所有内容源
   * 都有队列语义，判据是数据形状（这个 source 有没有队列），不是意图。
   */
  it('视频同样不支持切换上下条——它没有队列，"下一个"不该偷用陈旧的播客/音乐队列', async () => {
    const { createDomainState } = await import('../../src/state/domain')
    const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v) } }
    const state = createDomainState(mem())
    // 模拟"之前搜过播客，队列里还留着"——video.play 从不清队列，这份陈旧数据会一直躺着
    state.queue.set([
      { track: '入狱以后', artist: '故事FM', source: 'podcast', streamUrl: 'u1', artwork: '' },
      { track: '柏林墙与史塔西', artist: '故事FM', source: 'podcast', streamUrl: 'u2', artwork: '' },
    ] as any, 0, '播客搜索')
    const r2 = createRegistry(store, TOOLS, Date.now, { desk, state } as any)
    playing('video')
    const r = await r2.invoke('media.control', { action: 'next' })
    expect(r.status).toBe('rejected')
    expect(r.message).toContain('视频')
    expect(store.get('media.source'), '不该被陈旧队列偷走播放源').toBe('video')
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

/**
 * 实测（带孩子场景）：用户先让找动画片、说"没有就算了"，转而听儿歌，
 * 那张"找到这些视频"从第 2 轮一直挂到第 5 轮。
 *
 * 用户放弃某个话题是没有机制信号的（那属于意图理解）。但有一条约定成立：
 * **一次只在选一样东西**——开始挑歌的时候，视频候选就没意义了。
 * 所有候选列表共用一个 key，天然互斥，零新增机制。
 */
describe('候选列表一次只有一张', () => {
  const withCps = (extra: any) =>
    createRegistry(store, TOOLS, Date.now, { desk, ...extra } as any)

  it('搜歌之后再搜视频，屏幕上只剩视频那张', async () => {
    const r = withCps({
      itunes: { search: async () => [
        { id: 1, name: '小宝贝', artist: '儿歌', album: '', artwork: 'a', preview: 'p', duration: 60 },
        { id: 2, name: '两只老虎', artist: '儿歌', album: '', artwork: 'a', preview: 'p2', duration: 60 }] },
      pexels: { search: async () => [
        { id: 9, title: 'cartoon', author: 'x', duration: 10, cover: 'c', url: 'u', width: 360, height: 640 },
        { id: 8, title: 'cat', author: 'y', duration: 12, cover: 'c', url: 'u2', width: 360, height: 640 }] },
    })
    await r.invoke('music.search', { query: '儿歌' })
    await r.invoke('video.search', { query: '动画片' })
    const lists = desk.layout().cards.filter(c => c.template === 'list')
    expect(lists).toHaveLength(1)
    expect(lists[0].data.title).toContain('视频')
  })

  it('反过来也一样：搜完视频再搜歌，只剩歌那张', async () => {
    const r = withCps({
      itunes: { search: async () => [{ id: 1, name: '小宝贝', artist: '儿歌', album: '', artwork: 'a', preview: 'p', duration: 60 }] },
      pexels: { search: async () => [{ id: 9, title: 'cartoon', author: 'x', duration: 10, cover: 'c', url: 'u', width: 360, height: 640 }] },
    })
    await r.invoke('video.search', { query: '动画片' })
    await r.invoke('music.search', { query: '儿歌' })
    const lists = desk.layout().cards.filter(c => c.template === 'list')
    expect(lists).toHaveLength(1)
    expect(lists[0].data.title).toContain('歌')
  })
})

/**
 * ══════════ 媒体卡重设计 v2（2026-08-19）：队列点播与倍速 ══════════
 * 都是扩已有工具的参数（加能力=加数据），零新增 Tool。
 */
describe('media.control 扩参：jump 与 speed', () => {
  const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v) } }
  const withQueue = async () => {
    const { createDomainState } = await import('../../src/state/domain')
    const state = createDomainState(mem())
    const r2 = createRegistry(store, TOOLS, Date.now, { desk, state } as any)
    state.queue.set([
      { track: '歌1', artist: '人1', source: 'music', streamUrl: 'u1', artwork: '' },
      { track: '歌2', artist: '人2', source: 'music', streamUrl: 'u2', artwork: '' },
      { track: '歌3', artist: '人3', source: 'music', streamUrl: 'u3', artwork: '' },
    ] as any, 0, '测试')
    playing()
    return r2
  }
  it('jump：点队列第 n 首（0 起）直接播它——屏幕点播通道，不叫醒模型', async () => {
    const r2 = await withQueue()
    const r = await r2.invoke('media.control', { action: 'jump', index: 2 })
    expect(r.status).toBe('ok')
    expect(store.get('media.track')).toBe('歌3')
  })
  it('jump 越界给人话不炸', async () => {
    const r2 = await withQueue()
    const r = await r2.invoke('media.control', { action: 'jump', index: 99 })
    expect(r.status).toBe('rejected')
    expect(String(r.message)).not.toContain('undefined')
  })
  it('speed：倍速落信号，屏端照着设 playbackRate；范围外拒', async () => {
    const r2 = await withQueue()
    const r = await r2.invoke('media.control', { action: 'speed', speed: 1.25 })
    expect(r.status).toBe('ok')
    expect(store.get('media.speed')).toBe(1.25)
    const bad = await r2.invoke('media.control', { action: 'speed', speed: 9 })
    expect(bad.status).toBe('rejected')
  })
})

describe('musicPlay 挂歌词（异步锦上添花，不拖播放）', () => {
  it('播放成功后歌词落域仓、版本戳信号自增；拿不到歌词一切照常', async () => {
    const { createDomainState } = await import('../../src/state/domain')
    const mem = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v) } }
    const state = createDomainState(mem())
    const itunes = {
      search: async () => [{ name: '光亮', artist: '周深', album: 'x', artwork: 'a', preview: 'p', durationMs: 289000 }],
    }
    const lyrics = async () => '[00:12.00]也许世间所有的路'
    const r2 = createRegistry(store, TOOLS, Date.now, { desk, state, itunes, lyrics } as any)
    const r = await r2.invoke('music.play', { query: '光亮' })
    expect(r.status).toBe('ok')
    await new Promise(res => setTimeout(res, 0))   // 歌词是异步挂载
    expect(state.lyrics.for('光亮')).toContain('[00:12.00]')
    expect(Number(store.get('media.lyricsRev'))).toBeGreaterThan(0)
  })
})
