/**
 * iTunes Search API。
 *
 * 它**不支持 CORS** —— 以前只能走 JSONP（动态 script 注入），40 行代码全是
 * 为了绕这道墙：自增回调名（只靠时间戳会撞，浏览器把 performance.now() 粗化到
 * 100µs~1ms，并行两个搜索大概率同名，第二次覆盖第一次的 resolver，用户搜
 * 周杰伦拿到儿歌列表）、全局回调清理、script.onerror、4 秒超时。
 *
 * 2026-08-17 起走**同源代理**（`src/config/upstream.ts`），它就是一次普通
 * fetch，那 40 行连同它的坑一起删了。
 *
 * 免费、无需 Key、无需注册，限流约 20 次/分钟。
 * 只给 30 秒预览（previewUrl），**没有完整播放** —— 版权决定的，
 * 没有任何个人可注册的免费 CP 能提供华语流行乐整首播放。
 */

import { api } from '../config/upstream'

export interface Track {
  id: number
  name: string
  artist: string
  album: string
  artwork: string
  /** 30 秒试听直链（m4a），可以直接丢给 <audio> */
  preview: string
  /** 秒 */
  duration: number
}

export class ItunesError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

/** 注入 fetch 是为了测试能不打真实网络 */
export type Fetcher = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json(): Promise<any> }>

const toTrack = (r: any): Track => ({
  id: r.trackId,
  name: r.trackName,
  artist: r.artistName,
  album: r.collectionName ?? '',
  // 100x100 太糊，换成 300——URL 里是尺寸约定，官方一直这么用
  artwork: String(r.artworkUrl100 ?? '').replace('100x100', '300x300'),
  preview: r.previewUrl ?? '',
  duration: Math.round((r.trackTimeMillis ?? 0) / 1000),
})

export function createItunesClient(fetcher: Fetcher = ((u, i) => fetch(u, i)) as Fetcher,
                                   { timeoutMs = 4000 } = {}) {
  const search = async (term: string, limit = 8, country = 'CN'): Promise<Track[]> => {
    const q = new URLSearchParams({ term, media: 'music', entity: 'song', limit: String(limit), country })
    // per-request 超时：挂的时候它会拖住整轮 Promise.all（正常响应 <2s）
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
    let res
    try {
      res = await fetcher(`${api('itunes')}/search?${q}`, ac ? { signal: ac.signal } : undefined)
    } catch (e) {
      throw new ItunesError('iTunes 连不上', 'NETWORK')
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!res.ok) throw new ItunesError(`iTunes 返回 ${res.status ?? '错误'}`, 'HTTP')
    const json = await res.json()
    // 没有 preview 的条目对我们没用——放不出声的"搜到了"比没搜到更糟
    return (json?.results ?? []).map(toTrack).filter((t: Track) => t.preview)
  }

  return { search }
}

export type ItunesClient = ReturnType<typeof createItunesClient>
