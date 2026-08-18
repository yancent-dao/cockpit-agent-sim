/**
 * 腾讯行情（qt.gtimg.cn + smartbox.gtimg.cn）。
 *
 * 零 Key 零注册、秒级，A股/港股/美股/指数/汇率一个端点全包——接入清单
 * 梯队 02 里数据最全的一个。qt 带 ACAO:* 可浏览器直连（单文件版也能用）；
 * smartbox 不给 CORS，浏览器走同源代理（api() 自动分流）。
 *
 * 两个坑（清单里写明的）：响应是 **GBK**，要 TextDecoder('gbk') 解；
 * 无 schema，字段**靠位置数**——所以解析器对着 2026-08-18 抓的真实响应写，
 * 测试夹具就是那份原文。非官方接口，哪天变了没处说理，坏了要能看出来。
 */
import { api } from '../config/upstream'

export interface Quote {
  /** 可查代码，如 sh600519 / hkHSI / usAAPL / whUSDCNY */
  code: string
  name: string
  price: number
  /** 涨跌额（汇率是变动值） */
  change: number
  /** 涨跌幅 % */
  pct: number
  high?: number
  low?: number
}

export interface Hit { code: string; name: string; kind: string }

export class StockError extends Error {
  constructor(message: string, readonly codeName?: string) { super(message) }
}

/** 注入 fetch 为了测试不打真实网络。返回字节流——GBK 不能走 res.text() */
export type BinFetcher = (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>

const gbk = (buf: ArrayBuffer) => new TextDecoder('gbk').decode(buf)

const num = (s: string | undefined) => {
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 报价解析。`v_sh600519="1~贵州茅台~…";` 一行一只，字段按位置：
 * 股票/指数（sh/sz/hk/us）：1 名称 · 3 现价 · 31 涨跌 · 32 涨跌% · 33 高 · 34 低
 * 汇率（wh）另一套：3 现价 · 6 昨收 · 12 变动 · 13 变动%
 * 坏段跳过不炸——非官方接口，防御性优先。
 */
export function parseQuotes(text: string): Quote[] {
  const out: Quote[] = []
  for (const m of text.matchAll(/v_([A-Za-z0-9.]+)="([^"]*)"/g)) {
    const code = m[1]
    const f = m[2].split('~')
    if (f.length < 10) continue
    const name = f[1]
    const price = num(f[3])
    if (!name || price === undefined) continue
    if (code.startsWith('wh')) {
      const prev = num(f[6])
      out.push({
        code, name, price,
        change: num(f[12]) ?? (prev !== undefined ? Number((price - prev).toFixed(4)) : 0),
        pct: num(f[13]) ?? 0,
      })
    } else {
      out.push({
        code, name, price,
        change: num(f[31]) ?? 0, pct: num(f[32]) ?? 0,
        high: num(f[33]), low: num(f[34]),
      })
    }
  }
  return out
}

/**
 * smartbox 搜索解析。`v_hint="sh~600519~贵州茅台~gzmt~GP-A^…"`
 * 名称是 \uXXXX 转义（JSON.parse 解）；多命中用 ^ 分隔；
 * 美股代码带交易所后缀（AAPL.OQ）——查价时要剥掉。
 */
export function parseHint(text: string): Hit[] {
  const m = text.match(/v_hint="([^"]*)"/)
  if (!m || !m[1]) return []
  const out: Hit[] = []
  for (const seg of m[1].split('^')) {
    const f = seg.split('~')
    if (f.length < 3) continue
    const [market, rawCode, rawName] = f
    let name = rawName
    try { name = JSON.parse(`"${rawName}"`) } catch { /* 已是明文就原样用 */ }
    out.push({ code: market + rawCode.split('.')[0], name, kind: f[4] ?? '' })
  }
  return out
}

export function createStockClient(fetcher: BinFetcher, { timeoutMs = 5000 } = {}) {
  const get = async (url: string) => {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
    let res
    try { res = await fetcher(url) }
    catch { throw new StockError('行情服务连不上', 'NETWORK') }
    finally { if (timer) clearTimeout(timer) }
    if (!res.ok) throw new StockError(`行情服务返回 ${res.status ?? '错误'}`, 'HTTP')
    return gbk(await res.arrayBuffer())
  }

  /** 多代码一次查：q=sh600519,hkHSI,whUSDCNY */
  const quote = async (codes: string[]): Promise<Quote[]> =>
    parseQuotes(await get(`${api('qtstock')}/q=${codes.join(',')}`))

  /** 名字 → 候选代码。t=all 连指数、港美股一起搜 */
  const search = async (name: string): Promise<Hit[]> =>
    parseHint(await get(`${api('qtsmart')}/s3/?v=2&q=${encodeURIComponent(name)}&t=all`))

  return { quote, search }
}

export type StockClient = ReturnType<typeof createStockClient>
