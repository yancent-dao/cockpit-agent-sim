import { describe, it, expect, beforeEach } from 'vitest'
import { parseFeed, createPodcastClient } from '../../src/integrations/podcast'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { createDesk } from '../../src/cards/desk'
import { createDomainState } from '../../src/state/domain'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 播客（接入清单梯队 02）：发现走 iTunes（media=podcast，search 结果直接带
 * feedUrl，不用二跳 lookup——2026-08-18 真实响应确认过），播放走 RSS 直取
 * enclosure。**只实时流播，不缓存不存储**——feed 方的法律声明允许的恰是这一种。
 *
 * RSS 解析用正则不用 DOMParser：pilot 跑在 node 里没有 DOMParser，
 * 播客 RSS 的 item 结构又足够规整（夹具取自故事FM 的真实 feed）。
 */

const FEED = `<?xml version="1.0"?><rss><channel><title>故事FM</title>
<item>
<title><![CDATA[入狱以后，我一直在想是谁出卖了我｜柏林墙与史塔西]]></title>
<enclosure url="https://tk.wavpub.com/WPTK_abc.mp3" length="31532062" type="audio/mpeg"/>
<pubDate>Mon, 17 Aug 2026 21:50:26 +0800</pubDate>
<itunes:duration>2613</itunes:duration>
</item>
<item>
<title>普通标题不带CDATA</title>
<enclosure url="https://tk.wavpub.com/ep2.m4a" type="audio/x-m4a"/>
<itunes:duration>01:02:03</itunes:duration>
</item>
<item><title>没有音频的坏条目</title></item>
</channel></rss>`

describe('parseFeed', () => {
  it('CDATA 标题、enclosure、秒数时长都解出来；没音频的条目丢掉', () => {
    const eps = parseFeed(FEED)
    expect(eps).toHaveLength(2)
    expect(eps[0].title).toContain('柏林墙')
    expect(eps[0].url).toContain('WPTK_abc.mp3')
    expect(eps[0].duration).toBe(2613)
  })
  it('HH:MM:SS 形式的时长换算成秒', () => {
    expect(parseFeed(FEED)[1].duration).toBe(3723)
  })
})

describe('客户端', () => {
  it('episodes：直取 feed，非 2xx 给人话', async () => {
    const c = createPodcastClient(async () => ({ ok: true, text: async () => FEED } as any))
    const eps = await c.episodes('https://feeds.x.cn/a.xml')
    expect(eps).toHaveLength(2)
    const bad = createPodcastClient(async () => ({ ok: false, status: 403, text: async () => '' } as any))
    await expect(bad.episodes('https://x/y.xml')).rejects.toThrow(/播客/)
  })
})

describe('podcast.search / podcast.play（handler 层）', () => {
  let store: ReturnType<typeof createStore>
  let desk: ReturnType<typeof createDesk>
  let state: ReturnType<typeof createDomainState>
  const itunes = {
    search: async () => [],
    searchPodcasts: async (q: string) => q.includes('故事')
      ? [{ id: 1256399960, name: '故事FM', author: '寇爱哲', artwork: 'https://x/a.jpg', feedUrl: 'https://feeds.storyfm.cn/storyfm.xml', count: 984 }]
      : [],
  }
  const podcast = { episodes: async () => parseFeed(FEED) }
  beforeEach(() => {
    store = createStore(SIGNALS, CONSTRAINTS)
    desk = createDesk()
    state = createDomainState({ get: () => null, set: () => {} })
  })
  const mk = () => createRegistry(store, TOOLS, Date.now, { desk, state, itunes, podcast } as any)

  it('搜索出候选列表卡', async () => {
    const r = await mk().invoke('podcast.search', { query: '故事' })
    expect(r.status).toBe('ok')
    const card = desk.layout().cards.find(c => c.template === 'list')
    expect(card!.data.items[0].label).toContain('故事FM')
  })

  it('播放：默认最新一集，整批入队，播放态一次写齐', async () => {
    const r = await mk().invoke('podcast.play', { query: '故事' })
    expect(r.status).toBe('ok')
    expect(r.message).toContain('故事FM')
    expect(store.get('media.source')).toBe('podcast')
    expect(store.get('media.track')).toContain('柏林墙')
    expect(String(store.get('media.streamUrl'))).toContain('.mp3')
    expect(state.queue.size()).toBe(2)
  })

  it('搜不到节目给人话拒绝', async () => {
    const r = await mk().invoke('podcast.play', { query: '不存在的节目' })
    expect(r.status).toBe('unavailable')
  })
})
