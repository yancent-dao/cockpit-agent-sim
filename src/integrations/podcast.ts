/**
 * 播客 RSS 直取（接入清单梯队 02）。发现在 iTunes（media=podcast，
 * search 结果直接带 feedUrl），这里只管把 feed 里的单集解出来。
 *
 * **只实时流播，不缓存不存储不转录**——feed 方（如声湃）的法律声明
 * 明确允许的恰是"第三方实时流式播放 enclosure URL"这一种用法，
 * 我们把 URL 交给 <audio> 就完了，别越界。
 *
 * 解析用正则不用 DOMParser：pilot 跑在 node 里没有 DOMParser，而播客
 * RSS 的 item 结构足够规整（title/enclosure/duration/pubDate 四样）。
 * 主流托管商（声湃/小宇宙/喜马拉雅导出）实测都给 CORS；不给的那半边
 * 会抛人话错误——静态代理表没法转发任意域名，这是设计边界不是缺陷。
 */

export interface Episode {
  title: string
  /** enclosure 音频直链（mp3/m4a），直接喂 <audio> */
  url: string
  /** 秒 */
  duration?: number
  date?: string
}

export class PodcastError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>

const CD = /^<!\[CDATA\[([\s\S]*)\]\]>$/

/** <itunes:duration> 两种写法：纯秒数，或 HH:MM:SS / MM:SS */
const toSeconds = (s: string): number | undefined => {
  if (!s) return undefined
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map(Number)
  if (parts.some(n => !Number.isFinite(n))) return undefined
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

export function parseFeed(xml: string, limit = 30): Episode[] {
  const out: Episode[] = []
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    if (out.length >= limit) break
    const item = m[0]
    const title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '').trim().replace(CD, '$1').trim()
    const url = item.match(/<enclosure[^>]*\burl="([^"]+)"/)?.[1]
    if (!title || !url) continue   // 没音频的条目对播放器没意义
    out.push({
      title, url,
      duration: toSeconds(item.match(/<itunes:duration[^>]*>([^<]*)/)?.[1]?.trim() ?? ''),
      date: item.match(/<pubDate[^>]*>([^<]*)/)?.[1]?.trim(),
    })
  }
  return out
}

export function createPodcastClient(fetcher: Fetcher, { timeoutMs = 8000 } = {}) {
  const episodes = async (feedUrl: string): Promise<Episode[]> => {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
    let res
    try { res = await (fetcher as any)(feedUrl, ac ? { signal: ac.signal } : undefined) }
    catch { throw new PodcastError('这个播客源取不到（可能不允许浏览器直接访问）', 'NETWORK') }
    finally { if (timer) clearTimeout(timer) }
    if (!res.ok) throw new PodcastError(`播客源返回 ${res.status ?? '错误'}`, 'HTTP')
    const eps = parseFeed(await res.text())
    if (!eps.length) throw new PodcastError('播客源里没有可播的单集', 'EMPTY')
    return eps
  }
  return { episodes }
}

export type PodcastClient = ReturnType<typeof createPodcastClient>
