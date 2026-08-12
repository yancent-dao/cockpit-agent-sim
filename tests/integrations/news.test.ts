import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createNewsClient } from '../../src/integrations/news'
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

/** 字段照抄真实响应 */
const art = (n: number) => ({
  title: `新闻标题${n}`, description: `摘要${n}`,
  content: `正文${n}正文正文 [+892 chars]`,
  source: { id: null, name: `来源${n}` },
  url: `https://x/${n}`, urlToImage: `https://x/${n}.jpg`,
  publishedAt: '2026-08-11T02:56:09Z',
})

const fakeNews = (arts: any[], onUrl?: (u: string) => void): Fetcher =>
  (async (url: string) => {
    onUrl?.(url)
    return { ok: true, json: async () => ({ status: 'ok', totalResults: arts.length, articles: arts }) }
  }) as any

const mk = (f: Fetcher) =>
  createRegistry(store, TOOLS, Date.now, { desk, news: createNewsClient(f, () => 'k') } as any)

describe('NewsAPI 适配', () => {
  /**
   * 实测 country=cn 的 top-headlines 返回 0 条，NewsAPI 停掉了中国区源。
   * 中文只能降级成关键词搜索——这个事实要传上去，否则 Agent 会说
   * "这是今天的头条"，而它其实是搜出来的。
   */
  it('中文头条降级成关键词搜索，并如实标注不是真头条', async () => {
    let seen = ''
    const c = createNewsClient(fakeNews([art(1)], u => { seen = u }), () => 'k')
    const r = await c.headlines('technology', 'zh')
    expect(seen).toContain('/everything')
    expect(seen).toContain('sortBy=publishedAt')
    expect(r.real).toBe(false)
  })

  it('英文走真 top-headlines', async () => {
    let seen = ''
    const c = createNewsClient(fakeNews([art(1)], u => { seen = u }), () => 'k')
    const r = await c.headlines('technology', 'en')
    expect(seen).toContain('/top-headlines')
    expect(r.real).toBe(true)
  })

  // NewsAPI 把正文截断成 200 字并加个 "[+892 chars]" 尾巴，念出来很怪
  it('剥掉 NewsAPI 的截断标记', async () => {
    const c = createNewsClient(fakeNews([art(1)]), () => 'k')
    const r = await c.search('x')
    expect(r[0].content).not.toContain('chars]')
    expect(r[0].content).toContain('正文1')
  })

  it('没配 Key 时给的是人话，不是 undefined 炸进堆栈', async () => {
    const c = createNewsClient(fakeNews([]), () => '')
    await expect(c.search('x')).rejects.toThrow(/Key/)
  })

  it('NewsAPI 报错时把它的 message 带上来', async () => {
    const f = (async () => ({ ok: true, json: async () => ({ status: 'error', code: 'rateLimited', message: '超额了' }) })) as any
    await expect(createNewsClient(f, () => 'k').search('x')).rejects.toThrow(/超额/)
  })
})

describe('news.headlines / search', () => {
  it('结果自动上屏成带编号的列表', async () => {
    const r = mk(fakeNews([art(1), art(2)]))
    expect((await r.invoke('news.headlines', { category: 'technology' })).status).toBe('ok')
    const card = desk.findByKey('news')!
    expect(card.data.items[0].label).toContain('新闻标题1')
  })

  // 这条是防话术撒谎的：中文拿不到真头条，返回里必须让 Agent 知道
  it('中文结果里带着"不是真头条"这个事实', async () => {
    const r = mk(fakeNews([art(1)]))
    const res = await r.invoke('news.headlines', { category: 'general' })
    expect((res.data as any).real).toBe(false)
    expect(res.message).toMatch(/搜|不是头条|按时间/)
  })

  it('一条都没有 → unavailable', async () => {
    const r = mk(fakeNews([]))
    expect((await r.invoke('news.search', { query: '冷门词' })).status).toBe('unavailable')
  })
})

describe('news.read：车机场景是听不是看', () => {
  it('按序号读某一条，返回可朗读的正文', async () => {
    const r = mk(fakeNews([art(1), art(2)]))
    await r.invoke('news.headlines', {})
    const res = await r.invoke('news.read', { index: 2 })
    expect(res.status).toBe('ok')
    expect((res.data as any).title).toContain('新闻标题2')
    expect(String((res.data as any).text)).toContain('正文2')
  })

  it('序号超出范围时说清楚有几条', async () => {
    const r = mk(fakeNews([art(1)]))
    await r.invoke('news.headlines', {})
    const res = await r.invoke('news.read', { index: 9 })
    expect(res.status).toBe('rejected')
    expect(res.message).toContain('1')
  })

  it('还没列过新闻就要读 → 说清楚要先列', async () => {
    const r = mk(fakeNews([art(1)]))
    expect((await r.invoke('news.read', { index: 1 })).code).toBe('NO_LIST')
  })
})
