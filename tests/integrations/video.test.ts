import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createPexelsClient } from '../../src/integrations/pexels'
import type { Fetcher } from '../../src/integrations/amap'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

let store: ReturnType<typeof createStore>
let desk: ReturnType<typeof createDesk>

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  desk = createDesk()
})

/** 字段照抄真实响应：一个视频给好几档分辨率 */
const clip = (n: number) => ({
  id: n, url: `https://www.pexels.com/video/city-drive-${n}/`, duration: 17,
  image: `https://x/${n}.jpg`, user: { name: `作者${n}` },
  video_files: [
    { link: `https://x/${n}-hd.mp4`, width: 1920, height: 1080, file_type: 'video/mp4' },
    { link: `https://x/${n}-sd.mp4`, width: 360, height: 640, file_type: 'video/mp4' },
    { link: `https://x/${n}-4k.mp4`, width: 3840, height: 2160, file_type: 'video/mp4' },
  ],
})

const fakePexels = (videos: any[], onUrl?: (u: string) => void): Fetcher =>
  (async (url: string) => { onUrl?.(url); return { ok: true, json: async () => ({ videos }) } }) as any

const mk = (f: Fetcher) =>
  createRegistry(store, TOOLS, Date.now, { desk, pexels: createPexelsClient(f, () => 'k') } as any)

describe('Pexels 适配', () => {
  // 实测 360p 首帧 3.1 秒，4K 只会更慢，而车机卡片本来就小
  it('取最小分辨率档，不要 4K', async () => {
    const c = createPexelsClient(fakePexels([clip(1)]), () => 'k')
    const r = await c.search('drive')
    expect(r[0].url).toContain('-sd.mp4')
    expect(r[0].width).toBe(360)
  })

  it('要竖版，更像短视频', async () => {
    let seen = ''
    const c = createPexelsClient(fakePexels([clip(1)], u => { seen = u }), () => 'k')
    await c.search('x')
    expect(seen).toContain('orientation=portrait')
  })

  // Pexels 没有标题字段，得从 url 凑一个能念出来的
  it('从 url 凑出可朗读的标题', async () => {
    const c = createPexelsClient(fakePexels([clip(1)]), () => 'k')
    expect((await c.search('x'))[0].title).toBe('city drive')
  })

  it('没配 Key 给人话', async () => {
    await expect(createPexelsClient(fakePexels([]), () => '').search('x')).rejects.toThrow(/Key/)
  })
})

describe('video.search / play', () => {
  it('搜索结果自动上屏', async () => {
    const r = mk(fakePexels([clip(1), clip(2)]))
    expect((await r.invoke('video.search', { query: '风景' })).status).toBe('ok')
    expect(desk.findByKey('video-candidates')!.data.items).toHaveLength(2)
  })

  it('停车时能播，写满播放状态且画面打开', async () => {
    store.setDirect('vehicle.speed', 0)
    const r = mk(fakePexels([clip(1)]))
    const res = await r.invoke('video.play', { query: '风景' })
    expect(res.status).toBe('ok')
    expect(store.get('media.source')).toBe('video')
    expect(store.get('media.videoActive')).toBe(true)
    expect(store.get('media.playing')).toBe(true)
  })
})

/**
 * 行车安全。这条走约束引擎而不是 handler 里的 if——
 * 判据要是改了（比如允许副驾看），只动 constraints.ts 一条数据。
 */
describe('行驶中禁止看视频', () => {
  it('车在动就拒绝，而且给的是人话原因加替代方案', async () => {
    store.setDirect('vehicle.speed', 40)
    const r = mk(fakePexels([clip(1)]))
    const res = await r.invoke('video.play', { query: '风景' })
    expect(res.status).toBe('rejected')
    expect(res.message).toMatch(/车在动|行驶/)
    expect(res.suggestion).toMatch(/停稳|音乐|电台/)
  })

  it('被拒时不能留下半吊子状态——播放状态一个都不许写', async () => {
    store.setDirect('vehicle.speed', 40)
    const r = mk(fakePexels([clip(1)]))
    await r.invoke('video.play', { query: '风景' })
    expect(store.get('media.playing')).toBe(false)
    expect(store.get('media.source')).toBe('none')
    expect(store.get('media.videoActive')).toBe(false)
  })

  it('约束打在专用信号上，不会误伤音乐', async () => {
    store.setDirect('vehicle.speed', 60)
    const r = createRegistry(store, TOOLS, Date.now, {
      desk, pexels: createPexelsClient(fakePexels([clip(1)]), () => 'k'),
      itunes: { search: async () => [{ id: 1, name: '晴天', artist: '周杰伦', album: '叶惠美',
        artwork: 'https://x/a.jpg', preview: 'https://x/a.m4a', duration: 269 }] },
    } as any)
    expect((await r.invoke('music.play', { query: '晴天' })).status).toBe('ok')
    expect(store.get('media.playing')).toBe(true)
  })
})
