import { describe, it, expect } from 'vitest'
import { parseQuotes, parseHint, createStockClient } from '../../src/integrations/qtstock'

/**
 * 腾讯行情（qt.gtimg.cn）。零 Key 零注册、秒级、A股/港股/美股/汇率一个端点全包，
 * 带 ACAO:* 连单文件版都能直连——接入清单梯队 02 里数据最全的一个。
 *
 * 两个坑清单里写了：GBK 编码（TextDecoder('gbk') 解）；无 schema 字段靠位置数。
 * 所以下面的夹具全部是 2026-08-18 当天抓的**真实响应**（截断），
 * 解析器对着现实写，不对着记忆写。
 */

const A = `v_sh600519="1~贵州茅台~600519~1286.21~1293.09~1291.00~17139~7898~9230~1286.20~6~1286.18~1~1286.15~1~1286.02~4~1286.01~1~1286.25~4~1286.27~2~1286.28~1~1286.29~2~1286.30~2~~20260818103728~-6.88~-0.53~1298.86~1285.17~1286.21/17139/2210914711~17139~221091~0.14~19.74~~1298.86~1285.17~1.06~16078.67~16078.67~6.40~1422.40~1163.78~1.49~2~1290.01~18.06~19.53";`
const HK = `v_hkHSI="100~恒生指数~HSI~25318.220~25453.230~25368.870~8153208.4605~0~0~25318.220~0~0~0~0~0~0~0~0~0~25318.220~0~0~0~0~0~0~0~0~0~0.0~2026/08/18 10:22:29~-135.010~-0.53~25456.650~25240.620~25318.220~8153208.4605~8153208.460~0~0~~0~0~0.85~0~0~Hang Seng Index";`
const WH = `v_whUSDCNY="310~美元人民币~USDCNY~6.7434~0~20260818103701~6.7399~6.7428~6.7439~6.7421~6.7434~6.7435~0.0035~0.05~-0.02~-0.05~-0.34~-0.58~-3.48~7.1893~6.7380~2026-08-18";`
const HINT = `v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A"`

describe('报价解析（字段按位置，夹具是真实响应）', () => {
  it('A股：名称/现价/涨跌/涨跌幅/高低', () => {
    const [q] = parseQuotes(A)
    expect(q.name).toBe('贵州茅台')
    expect(q.code).toBe('sh600519')
    expect(q.price).toBe(1286.21)
    expect(q.change).toBe(-6.88)
    expect(q.pct).toBe(-0.53)
    expect(q.high).toBe(1298.86)
    expect(q.low).toBe(1285.17)
  })

  it('港股指数同一套位置', () => {
    const [q] = parseQuotes(HK)
    expect(q.name).toBe('恒生指数')
    expect(q.price).toBe(25318.22)
    expect(q.change).toBe(-135.01)
    expect(q.pct).toBe(-0.53)
  })

  it('汇率是另一套位置：涨跌在 12/13，昨收在 6（用昨收校验过）', () => {
    const [q] = parseQuotes(WH)
    expect(q.name).toBe('美元人民币')
    expect(q.price).toBe(6.7434)
    expect(q.change).toBe(0.0035)
    expect(q.pct).toBe(0.05)
  })

  it('多只并列一次解出，坏段跳过不炸', () => {
    const qs = parseQuotes(A + '\n' + HK + '\nv_bad="1~2";')
    expect(qs.length).toBeGreaterThanOrEqual(2)
  })
})

describe('smartbox 搜索解析', () => {
  it('unicode 转义解回中文，市场前缀拼成可查代码', () => {
    const hits = parseHint(HINT)
    expect(hits[0]).toEqual({ code: 'sh600519', name: '贵州茅台', kind: 'GP-A' })
  })
  it('美股代码剥掉交易所后缀（AAPL.OQ → usAAPL）', () => {
    const hits = parseHint(`v_hint="us~AAPL.OQ~\\u82f9\\u679c~pg~GP-US"`)
    expect(hits[0].code).toBe('usAAPL')
  })
})

describe('客户端（GBK 字节流进来）', () => {
  const gbkOf = (s: string) => {
    // 测试里没有 GBK 编码器，用 TextEncoder 不行——但 ASCII 部分 GBK=ASCII，
    // 真正的中文解码路径由上面真实夹具的 parse 层保证；这里只验管道走通
    return new TextEncoder().encode(s).buffer
  }
  it('quote：分号连接多代码一次查', async () => {
    let seen = ''
    const c = createStockClient(async u => { seen = String(u); return { ok: true, arrayBuffer: async () => gbkOf(A) } as any })
    const qs = await c.quote(['sh600519'])
    expect(seen).toContain('q=sh600519')
    expect(qs[0].price).toBe(1286.21)
  })
  it('search：走 smartbox', async () => {
    let seen = ''
    const c = createStockClient(async u => { seen = String(u); return { ok: true, arrayBuffer: async () => gbkOf(HINT) } as any })
    const hits = await c.search('茅台')
    expect(seen).toContain('smartbox')
    expect(hits[0].name).toBe('贵州茅台')
  })
})
