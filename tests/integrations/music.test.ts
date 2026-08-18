import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createItunesClient, type Fetcher } from '../../src/integrations/itunes'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk()
})

const song = (n: number, over: any = {}) => ({
  trackId: n, trackName: `歌${n}`, artistName: `歌手${n}`, collectionName: `专辑${n}`,
  artworkUrl100: `https://x/100x100/${n}.jpg`, previewUrl: `https://x/${n}.m4a`,
  trackTimeMillis: 215000, ...over,
})

/** 假 fetch：不打真实网络，但走真实的 createItunesClient 拼装链路 */
const fakeItunes = (results: any[], onUrl?: (u: string) => void): Fetcher => async url => {
  onUrl?.(String(url))
  return { ok: true, json: async () => ({ resultCount: results.length, results }) } as any
}

const mk = (f: Fetcher) =>
  createRegistry(store, TOOLS, Date.now, { desk, itunes: createItunesClient(f) } as any)

describe('iTunes 适配', () => {
  /**
   * **JSONP 退役了**（2026-08-17）。iTunes 不支持 CORS，以前只能走动态
   * script 注入 —— 40 行代码全是为了绕开一道墙：自增回调名（时间戳被
   * Spectre 缓解粗化后并行搜索会撞名、把周杰伦的结果 resolve 给儿歌）、
   * 全局回调清理、script.onerror、4 秒超时。同源代理之后它就是一次
   * 普通 fetch，那 40 行连同它的坑一起删掉。
   */
  it('走同源代理的普通 fetch，JSONP 那套彻底退役', async () => {
    vi.stubGlobal('location', { protocol: 'http:' })   // 模拟浏览器：有 dev server 在转发
    try {
      let seen = ''
      const c = createItunesClient(fakeItunes([song(1)], u => { seen = u }))
      await c.search('周杰伦')
      expect(seen, '经代理，不再直连 itunes.apple.com').toContain('/x/itunes/search')
      expect(seen).toContain('entity=song')
      expect(seen, 'JSONP 的 callback 参数不该再出现').not.toContain('callback=')
    } finally { vi.unstubAllGlobals() }
  })

  it('node 环境（pilot）没有转发层，如实直连原 host', async () => {
    let seen = ''
    const c = createItunesClient(fakeItunes([song(1)], u => { seen = u }))
    await c.search('周杰伦')
    expect(seen).toContain('itunes.apple.com/search')
  })

  it('上游报错要说人话，不是抛裸异常', async () => {
    const c = createItunesClient(async () => ({ ok: false, status: 503 } as any))
    await expect(c.search('x')).rejects.toThrow(/iTunes/)
  })

  it('封面换成 300 尺寸——100x100 在车机上太糊', async () => {
    const c = createItunesClient(fakeItunes([song(1)]))
    expect((await c.search('x'))[0].artwork).toContain('300x300')
  })

  // 放不出声的"搜到了"比没搜到更糟
  it('没有试听地址的条目直接丢掉', async () => {
    const c = createItunesClient(fakeItunes([song(1, { previewUrl: undefined }), song(2)]))
    const r = await c.search('x')
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe(2)
  })
})

describe('music.search', () => {
  it('多个结果自动上屏成带编号的列表', async () => {
    const r = mk(fakeItunes([song(1), song(2), song(3)]))
    const res = await r.invoke('music.search', { query: '周杰伦' })
    expect(res.status).toBe('ok')
    const card = desk.findByKey('candidates')!
    expect(card.template).toBe('list')
    expect(card.data.items[0].label).toContain('歌1')
  })

  it('一首都没搜到 → unavailable，不能假装成功', async () => {
    const r = mk(fakeItunes([]))
    const res = await r.invoke('music.search', { query: '不存在的歌' })
    expect(res.status).toBe('unavailable')
    expect(res.code).toBe('NO_RESULT')
    expect(res.suggestion).toBeTruthy()
  })
})

describe('music.play', () => {
  it('按 trackId 播 → 写满播放状态，播放器卡该有的数据都齐了', async () => {
    const r = mk(fakeItunes([song(1), song(2)]))
    await r.invoke('music.search', { query: 'x' })
    const res = await r.invoke('music.play', { trackId: 2 })
    expect(res.status).toBe('ok')
    expect(store.get('media.playing')).toBe(true)
    expect(store.get('media.source')).toBe('music')
    expect(store.get('media.track')).toBe('歌2')
    expect(store.get('media.artist')).toBe('歌手2')
    expect(store.get('media.streamUrl')).toBe('https://x/2.m4a')
    expect(store.get('media.artwork')).toContain('300x300')
  })

  it('不给 trackId 直接给关键词 → 搜到就播第一首，省一轮往返', async () => {
    const r = mk(fakeItunes([song(7)]))
    const res = await r.invoke('music.play', { query: '晴天' })
    expect(res.status).toBe('ok')
    expect(store.get('media.track')).toBe('歌7')
  })

  it('播了之后候选列表就翻篇了，撤掉', async () => {
    const r = mk(fakeItunes([song(1), song(2)]))
    await r.invoke('music.search', { query: 'x' })
    expect(desk.findByKey('candidates')).toBeTruthy()
    await r.invoke('music.play', { trackId: 1 })
    expect(desk.findByKey('candidates')).toBeUndefined()
  })

  // 只有 30 秒是 iTunes 的硬限制，不能让 Agent 以为能放整首
  it('返回里带上"只有 30 秒预览"，让 Agent 有机会说清楚', async () => {
    const r = mk(fakeItunes([song(1)]))
    const res = await r.invoke('music.play', { query: 'x' })
    expect(JSON.stringify(res)).toMatch(/30\s*秒|预览|试听/)
  })

  it('搜不到要播的东西 → unavailable', async () => {
    const r = mk(fakeItunes([]))
    expect((await r.invoke('music.play', { query: '没有这首' })).status).toBe('unavailable')
  })
})
