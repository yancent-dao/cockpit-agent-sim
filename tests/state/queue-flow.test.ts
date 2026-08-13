import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createDomainState } from '../../src/state/domain'
import { createAutoplay } from '../../src/integrations/mediaHandlers'
import { createItunesClient } from '../../src/integrations/itunes'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 修"诚实的残端"：media.control 声明了 next/prev 但返回 NO_QUEUE；
 * ended 事件上报后没有任何消费者，歌放完就静音挂着。
 *
 * 现在：music.play 把同批搜索结果**整批入队**；next/prev 有的放矢；
 * ended → 机制层自动续播，**全程零模型调用**（公理 4）。
 */

const FAKE_TRACKS = {
  results: [1, 2, 3].map(i => ({
    trackId: i, trackName: '歌' + i, artistName: '人' + i, collectionName: '专辑',
    artworkUrl100: 'https://a/' + i, previewUrl: 'https://p/' + i,
  })),
}

let store: ReturnType<typeof createStore>
let state: ReturnType<typeof createDomainState>
let reg: ReturnType<typeof createRegistry>

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  state = createDomainState({ get: () => null, set: () => {} })
  reg = createRegistry(store, TOOLS, Date.now, {
    desk: createDesk(),
    state,
    itunes: createItunesClient(async () => FAKE_TRACKS),
  })
})

describe('搜索命中 → 整批入队', () => {
  it('music.play 之后队列里有整批结果，cursor 在命中项', async () => {
    await reg.invoke('music.play', { query: '歌' })
    expect(state.queue.size()).toBe(3)
    expect(state.queue.current()!.track).toBe('歌1')
  })

  it('media.control next 播下一首——不再 NO_QUEUE', async () => {
    await reg.invoke('music.play', { query: '歌' })
    const r = await reg.invoke('media.control', { action: 'next' })
    expect(r.status).toBe('ok')
    expect(store.get('media.track')).toBe('歌2')
    expect(store.get('media.playing')).toBe(true)
  })

  it('media.queue 说得出接下来是什么', async () => {
    await reg.invoke('music.play', { query: '歌' })
    const r = await reg.invoke('media.queue', {})
    expect(r.status).toBe('ok')
    expect((r.data as any).upcoming.map((x: any) => x.track)).toEqual(['歌2', '歌3'])
  })

  it('播放历史被记下——"再放刚才那首"有据可查', async () => {
    await reg.invoke('music.play', { query: '歌' })
    await reg.invoke('media.control', { action: 'next' })
    expect(state.history.recent(2).map(x => x.track)).toEqual(['歌2', '歌1'])
  })
})

describe('ended → 机制自动续播（零模型）', () => {
  // 假时钟每次跳 30 秒——保险丝只熔断"打开即 ended"的坏流，正常听完不误伤
  const mkAp = () => { let now = 0; const ap = createAutoplay(store, state, () => now)
    return { ended: () => { now += 30_000; ap.onEnded() } } }

  it('放完自动下一首，写的是信号不是对话', async () => {
    await reg.invoke('music.play', { query: '歌' })
    const ap = mkAp()
    ap.ended()
    expect(store.get('media.track')).toBe('歌2')
    expect(store.get('media.playing')).toBe(true)
  })

  it('顺序模式到尾：停下，不静音挂着也不硬循环', async () => {
    await reg.invoke('music.play', { query: '歌' })
    const ap = mkAp()
    ap.ended(); ap.ended()
    expect(store.get('media.track')).toBe('歌3')
    ap.ended()
    expect(store.get('media.playing'), '到尾了就停').toBe(false)
  })

  it('单曲循环：ended 重放当前', async () => {
    await reg.invoke('music.play', { query: '歌' })
    store.setDirect('media.mode', 'repeatOne')
    mkAp().ended()
    expect(store.get('media.track')).toBe('歌1')
    expect(store.get('media.playing')).toBe(true)
  })
})

describe('收藏走域仓', () => {
  it('media.favorite 落进 state.favorites', async () => {
    await reg.invoke('music.play', { query: '歌' })
    await reg.invoke('media.favorite', {})
    expect(state.favorites.list().map(f => f.track)).toContain('歌1')
  })
})

/**
 * 用户实拍 bug：点暂停播放器卡直接消失。
 * 根因：规则条件写的是 media.playing == true——暂停一落信号规则判死刑撤卡。
 * **暂停是状态不是退场理由**：有内容加载着（source != none）卡就该在，
 * 显示 ▶ 等着继续；stop（整个清掉）才退场。真车机都是这个语义。
 */
describe('暂停不退卡', () => {
  it('media.control toggle：播放中按一下变暂停，再按恢复——按钮语义是切换', async () => {
    await reg.invoke('music.play', { query: '歌' })
    expect(store.get('media.playing')).toBe(true)
    await reg.invoke('media.control', { action: 'toggle' })
    expect(store.get('media.playing')).toBe(false)
    await reg.invoke('media.control', { action: 'toggle' })
    expect(store.get('media.playing')).toBe(true)
  })
})

/**
 * 续播保险丝：坏流（打开即 ended 的失效预览）会让自动续播链式跳歌——
 * 用户听感"每两秒音乐重新放一遍"。距上次续播不足 5 秒又收到 ended，
 * 判定流坏了：停下并示警，不再往下跳。
 */
describe('续播保险丝', () => {
  it('两次 ended 间隔 <5 秒 → 停播不跳下一首', async () => {
    let now = 0
    await reg.invoke('music.play', { query: '歌' })
    const ap = createAutoplay(store, state, () => now)
    now = 10_000; ap.onEnded()                       // 正常放完 10 秒，续播 ✓
    expect(store.get('media.track')).toBe('歌2')
    now = 11_000; ap.onEnded()                       // 1 秒就 ended：流坏了
    expect(store.get('media.playing'), '保险丝熔断').toBe(false)
  })

  it('正常听完整首（>5 秒）续播照常', async () => {
    let now = 0
    await reg.invoke('music.play', { query: '歌' })
    const ap = createAutoplay(store, state, () => now)
    now = 30_000; ap.onEnded()
    now = 60_000; ap.onEnded()
    expect(store.get('media.track')).toBe('歌3')
    expect(store.get('media.playing')).toBe(true)
  })
})
