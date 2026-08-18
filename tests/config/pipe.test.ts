import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNewsClient } from '../../src/integrations/news'
import { createPexelsClient } from '../../src/integrations/pexels'
import { createOpenMeteoClient } from '../../src/integrations/openmeteo'
import { createAmapClient } from '../../src/integrations/amap'
import { createImageClient } from '../../src/integrations/orimage'
import { createRadioClient } from '../../src/integrations/radio'
import { proxiedWsUrl } from '../../src/integrations/xftts'

/**
 * ══════════ 管道兑现（2026-08-17，接入清单梯队 00）══════════
 *
 * 上游表建好了，但全 src/ 只有 itunes 真的走 api() —— 其余客户端
 * 仍在硬编码直连 origin，表建好了管子没接上。这批测试盯住：
 * **浏览器环境（http）一律走 /x/<name> 同源代理，node/file:// 退直连。**
 *
 * 收益各不相同但都真实：newsapi 解开「免费层仅限 localhost 禁止部署」
 * （请求从 Node 发出）；openrouter/pexels 为藏 Key 留好位置；
 * radio 多一个不会挂的首选节点；amap/openmeteo 统一口径。
 */

const inBrowser = () => vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
afterEach(() => vi.unstubAllGlobals())

const cap = () => {
  const urls: string[] = []
  const f = async (u: string) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({}) } as any }
  return { urls, f }
}

describe('浏览器走同源代理', () => {
  it('newsapi → /x/newsapi（顺带解开免费层的部署禁令）', async () => {
    inBrowser()
    const { urls, f } = cap()
    await createNewsClient(f as any, () => 'k').headlines().catch(() => {})
    expect(urls[0]).toContain('/x/newsapi/v2/')
  })

  it('pexels → /x/pexels', async () => {
    inBrowser()
    const { urls, f } = cap()
    await createPexelsClient(f as any, () => 'k').search('猫').catch(() => {})
    expect(urls[0]).toContain('/x/pexels/videos/search')
  })

  it('openmeteo → /x/openmeteo', async () => {
    inBrowser()
    const { urls, f } = cap()
    await createOpenMeteoClient(f as any).forecast(30.6, 104).catch(() => {})
    expect(urls[0]).toContain('/x/openmeteo/v1/forecast')
  })

  it('amap → /x/amap（静态图 URL 同样过代理）', async () => {
    inBrowser()
    const { urls, f } = cap()
    const c = createAmapClient(f as any, { webKey: 'k' } as any)
    await c.geocode('春熙路', '成都').catch(() => {})
    expect(urls[0]).toContain('/x/amap/v3/')
  })

  it('orimage → /x/openrouter', async () => {
    inBrowser()
    const { urls, f } = cap()
    await createImageClient(f as any, () => 'k').generate({ prompt: '画只猫' } as any).catch(() => {})
    expect(urls[0]).toContain('/x/openrouter/api/v1/images')
  })

  it('radio：代理是首选节点，直连节点仍是后备（多一个不会挂的节点，不是换掉故障切换）', async () => {
    inBrowser()
    const { urls, f } = cap()
    await createRadioClient(f as any).search({ name: '民谣' } as any).catch(() => {})
    expect(urls[0]).toContain('/x/radio/json')
  })
})

describe('node 环境退直连（pilot 跑批没有转发层）', () => {
  it('newsapi 直连原 host', async () => {
    const { urls, f } = cap()
    await createNewsClient(f as any, () => 'k').headlines().catch(() => {})
    expect(urls[0]).toContain('newsapi.org')
  })
})

describe('讯飞 ws 走代理', () => {
  it('proxiedWsUrl：签名照旧对上游算，连接换成同源 /x/xftts', () => {
    inBrowser()
    const direct = 'wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6?authorization=abc&date=x&host=cbm01.cn-huabei-1.xf-yun.com'
    const p = proxiedWsUrl(direct)
    expect(p).toBe('ws://localhost:5173/x/xftts/v1/private/mcd9m97e6?authorization=abc&date=x&host=cbm01.cn-huabei-1.xf-yun.com')
  })
  it('https 页面出 wss 代理', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'demo.example.com' })
    const p = proxiedWsUrl('wss://cbm01.cn-huabei-1.xf-yun.com/v1/x?q=1')
    expect(p).toBe('wss://demo.example.com/x/xftts/v1/x?q=1')
  })
})

describe('newsapi 的可达性回退', () => {
  /**
   * 实测：newsapi.org 在 Node 侧被 DNS 污染（解析到 108.160.169.171 连接超时），
   * 而浏览器侧常因系统代理是通的 —— 可达性的墙代理不解决（清单里写明的边界）。
   * 代理这跳失败就退回浏览器直连，别让接管道反而把能用的弄坏。
   */
  it('代理挂了退直连原 host', async () => {
    inBrowser()
    const urls: string[] = []
    const f = async (u: string) => {
      urls.push(String(u))
      if (String(u).startsWith('/x/')) throw new Error('ETIMEDOUT')
      return { ok: true, status: 200, json: async () => ({ articles: [] }) } as any
    }
    await createNewsClient(f as any, () => 'k').headlines().catch(() => {})
    expect(urls[0]).toContain('/x/newsapi/')
    expect(urls[1]).toContain('https://newsapi.org/')
  })
})
