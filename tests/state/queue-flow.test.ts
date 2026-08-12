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
  it('放完自动下一首，写的是信号不是对话', async () => {
    await reg.invoke('music.play', { query: '歌' })
    const autoplay = createAutoplay(store, state)
    autoplay.onEnded()
    expect(store.get('media.track')).toBe('歌2')
    expect(store.get('media.playing')).toBe(true)
  })

  it('顺序模式到尾：停下，不静音挂着也不硬循环', async () => {
    await reg.invoke('music.play', { query: '歌' })
    const autoplay = createAutoplay(store, state)
    autoplay.onEnded(); autoplay.onEnded()
    expect(store.get('media.track')).toBe('歌3')
    autoplay.onEnded()
    expect(store.get('media.playing'), '到尾了就停').toBe(false)
  })

  it('单曲循环：ended 重放当前', async () => {
    await reg.invoke('music.play', { query: '歌' })
    store.setDirect('media.mode', 'repeatOne')
    createAutoplay(store, state).onEnded()
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
