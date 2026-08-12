import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createRadioClient } from '../../src/integrations/radio'
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

/** 字段名照抄真实响应，不是凭记忆编的 */
const station = (n: number, over: any = {}) => ({
  stationuuid: `uuid-${n}`, name: `电台${n}`, url_resolved: `https://s${n}.example.com/live.mp3`,
  codec: 'MP3', bitrate: 128, country: 'China', language: 'chinese', tags: 'news',
  favicon: `https://s${n}.example.com/i.png`, ...over,
})

const fakeRadio = (list: any[], onUrl?: (u: string) => void): Fetcher =>
  (async (url: string) => { onUrl?.(url); return { ok: true, json: async () => list } }) as any

const mk = (f: Fetcher) =>
  createRegistry(store, TOOLS, Date.now, { desk, radio: createRadioClient(f) } as any)

describe('Radio Browser 适配', () => {
  /**
   * 同一个台常有 https 和 http 两条流（真实数据里就是这样）。
   * HTTPS 页面加载 http 流会被浏览器的 mixed content 拦掉，
   * 用户看到"已经在放了"但一点声音没有——比搜不到更糟。
   */
  it('只留 HTTPS 流，http 的直接丢掉', async () => {
    const c = createRadioClient(fakeRadio([
      station(1, { url_resolved: 'http://insecure.example.com/live' }),
      station(2),
    ]))
    const r = await c.search({ name: '中国' })
    expect(r).toHaveLength(1)
    expect(r[0].url).toMatch(/^https:/)
  })

  it('按热度排序，把最可能能听的排前面', async () => {
    let seen = ''
    const c = createRadioClient(fakeRadio([station(1)], u => { seen = u }))
    await c.search({ name: 'x' })
    expect(seen).toContain('order=clickcount')
    expect(seen).toContain('hidebroken=true')   // 挂掉的台不要
  })

  it('分类/国家/语言都能筛', async () => {
    let seen = ''
    const c = createRadioClient(fakeRadio([station(1)], u => { seen = u }))
    await c.search({ tag: 'jazz', country: 'China', language: 'chinese' })
    expect(seen).toContain('tag=jazz')
    expect(seen).toContain('country=China')
    expect(seen).toContain('language=chinese')
  })
})

/**
 * 实测：主域名 api.radio-browser.info 返回 404，只有具体节点（de1/de2）能用，
 * 而且节点会挂——fi1 当场就连不上。官方推荐用 DNS 查所有节点，
 * 但浏览器里做不了 DNS 查询，只能硬编码一组然后失败切换。
 */
describe('节点回退', () => {
  it('第一个节点挂了自动试下一个', async () => {
    const tried: string[] = []
    const f = (async (url: string) => {
      tried.push(new URL(url).host)
      if (tried.length === 1) throw new Error('connect ECONNREFUSED')
      return { ok: true, json: async () => [station(1)] }
    }) as any
    const r = await createRadioClient(f).search({ name: 'x' })
    expect(r).toHaveLength(1)
    expect(tried).toHaveLength(2)
    expect(tried[0]).not.toBe(tried[1])
  })

  it('节点返回非 200 也算挂，继续切', async () => {
    let n = 0
    const f = (async () => (++n === 1 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => [station(2)] })) as any
    expect(await createRadioClient(f).search({ name: 'x' })).toHaveLength(1)
  })

  it('全挂了才报错，而且是人话', async () => {
    const f = (async () => { throw new Error('boom') }) as any
    await expect(createRadioClient(f).search({ name: 'x' })).rejects.toThrow(/电台/)
  })

  // 别每次都从第一个节点重试——上次成功的那个大概率还活着
  it('记住上次成功的节点', async () => {
    const tried: string[] = []
    let n = 0
    const f = (async (url: string) => {
      tried.push(new URL(url).host)
      if (++n === 1) throw new Error('down')
      return { ok: true, json: async () => [station(1)] }
    }) as any
    const c = createRadioClient(f)
    await c.search({ name: 'a' })
    await c.search({ name: 'b' })
    expect(tried[1]).toBe(tried[2])   // 第二次直接用上次成功的
  })
})

describe('radio.search', () => {
  it('结果自动上屏成带编号的列表', async () => {
    const r = mk(fakeRadio([station(1), station(2)]))
    expect((await r.invoke('radio.search', { query: '中国之声' })).status).toBe('ok')
    const card = desk.findByKey('candidates')!
    expect(card.data.items[0].label).toContain('电台1')
  })

  // 全是 http 流时等于没找到，不能让 Agent 说"找到了"
  it('筛完 HTTPS 一个不剩 → unavailable 并说清原因', async () => {
    const r = mk(fakeRadio([station(1, { url_resolved: 'http://a/live' })]))
    const res = await r.invoke('radio.search', { query: 'x' })
    expect(res.status).toBe('unavailable')
    expect(res.message).toBeTruthy()
  })
})

describe('radio.play', () => {
  it('播上了就写满播放状态，来源是 radio', async () => {
    const r = mk(fakeRadio([station(1), station(2)]))
    await r.invoke('radio.search', { query: 'x' })
    const res = await r.invoke('radio.play', { stationId: 'uuid-2' })
    expect(res.status).toBe('ok')
    expect(store.get('media.source')).toBe('radio')
    expect(store.get('media.track')).toBe('电台2')
    expect(store.get('media.streamUrl')).toBe('https://s2.example.com/live.mp3')
    expect(store.get('media.playing')).toBe(true)
  })

  it('直接给台名也能播，不用先 search', async () => {
    const r = mk(fakeRadio([station(9)]))
    expect((await r.invoke('radio.play', { query: '音乐之声' })).status).toBe('ok')
    expect(store.get('media.track')).toBe('电台9')
  })

  it('播上之后候选列表翻篇，撤掉', async () => {
    const r = mk(fakeRadio([station(1), station(2)]))
    await r.invoke('radio.search', { query: 'x' })
    await r.invoke('radio.play', { stationId: 'uuid-1' })
    expect(desk.findByKey('candidates')).toBeUndefined()
  })

  // 电台是直播，没有"艺人"，把台的地区语言放进去更有用
  it('副标题给的是地区和分类，不是空的艺人字段', async () => {
    const r = mk(fakeRadio([station(1)]))
    await r.invoke('radio.play', { query: 'x' })
    expect(String(store.get('media.artist'))).toContain('China')
  })
})
