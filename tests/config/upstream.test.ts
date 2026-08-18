import { describe, it, expect } from 'vitest'
import { UPSTREAM, PROXY_PREFIX, api, proxyTable } from '../../src/config/upstream'

/**
 * ══════════ 同源代理:去掉 CORS 这道墙（2026-08-17 产品决策）══════════
 *
 * CORS 不是我们的规则，是浏览器的；我们的规则是「零后端」，是它逼着
 * 只能挑开了 CORS 的服务。代价已经很具体：iTunes 被迫走 40 行 JSONP、
 * 联网搜索绕一圈走 LLM（Tavily/Brave 故意关 CORS）、豆包/阿里 TTS
 * 因为 WebSocket 鉴权在 header 而**完全接不进来**、Key 只能暴露在前端。
 *
 * 解法只有一种本质：一个同源的转发层。这里选的形态是 **Vite 自带的
 * dev/preview proxy** —— 零新增依赖、零后端代码、产物仍是静态文件，
 * 而 Demo 的真实场景（npm run dev 然后投屏）本就跑在它上面。
 *
 * 纪律：**代理层里不许有业务逻辑**。它只做转发、改 header、藏 Key，
 * 出现内容判断/拼业务参数/解析响应即违规——那些归 src/integrations/。
 */

describe('上游表是单一事实来源', () => {
  it('每个上游都是完整的 http(s)/ws(s) origin，不带路径', () => {
    for (const [k, v] of Object.entries(UPSTREAM)) {
      expect(v, k).toMatch(/^(https|wss):\/\//)
      expect(new URL(v).pathname, `${k} 只该给 origin`).toBe('/')
    }
  })

  it('proxyTable 为每个上游生成一条转发规则，路径前缀不撞业务路由', () => {
    const t = proxyTable()
    expect(Object.keys(t).sort()).toEqual(Object.keys(UPSTREAM).map(k => PROXY_PREFIX + k).sort())
    const one = t[PROXY_PREFIX + 'itunes']
    expect(one.target).toBe(UPSTREAM.itunes)
    expect(one.changeOrigin, '不改 Origin 上游会按跨域拒绝').toBe(true)
    // 前缀 /x/ 不跟 index.html / screen.html / src / gallery 撞
    expect(PROXY_PREFIX.startsWith('/')).toBe(true)
  })

  it('rewrite 把代理前缀剥掉 —— 上游收到的是它自己的原始路径', () => {
    const r = proxyTable()[PROXY_PREFIX + 'amap'].rewrite!
    expect(r('/x/amap/v3/geocode/geo?address=春熙路')).toBe('/v3/geocode/geo?address=春熙路')
  })
})

describe('api()：运行时挑路', () => {
  it('http(s) 环境（dev/preview/测试）走同源代理', () => {
    expect(api('itunes', 'https:')).toBe('/x/itunes')
    expect(api('amap', 'http:')).toBe('/x/amap')
  })

  /**
   * 单文件版是 file:// 双击打开的，没有 dev server 也就没有转发 ——
   * 只能直连（它本来就受限，见已知待办：读不到 import.meta.env）。
   */
  it('file:// 单文件版直连原 host', () => {
    expect(api('itunes', 'file:')).toBe(UPSTREAM.itunes)
  })
})
