/**
 * iTunes Search API。
 *
 * 它**不支持 CORS**，所以不能用 fetch —— 走 JSONP（动态 <script> + callback 参数），
 * 这也是 Apple 官方文档教的用法。零后端的前提下这是唯一可行的路子。
 *
 * 免费、无需 Key、无需注册，限流约 20 次/分钟。
 * 只给 30 秒预览（previewUrl），**没有完整播放** —— 版权决定的，
 * 没有任何个人可注册的免费 CP 能提供华语流行乐整首播放。
 */

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

/** JSONP 载入器。注入是为了测试能不打真实网络 */
export type Jsonp = (url: string, callbackParam: string) => Promise<any>

/** 浏览器实现：动态 script 标签。iTunes 没有 CORS，这是唯一的路 */
export const browserJsonp: Jsonp = (url, cbParam) =>
  new Promise((resolve, reject) => {
    const name = `__itunes_cb_${Math.floor(performance.now() * 1000)}`
    const el = document.createElement('script')
    const done = (fn: () => void) => {
      delete (window as any)[name]
      el.remove()
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new ItunesError('iTunes 没有响应', 'TIMEOUT'))), 4000)   // 8s→4s：正常响应 <2s，挂的时候它拖住整轮 Promise.all
    ;(window as any)[name] = (data: any) => done(() => resolve(data))
    el.onerror = () => done(() => reject(new ItunesError('iTunes 连不上', 'NETWORK')))
    el.src = `${url}&${cbParam}=${name}`
    document.head.appendChild(el)
  })

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

export function createItunesClient(jsonp: Jsonp = browserJsonp) {
  const search = async (term: string, limit = 8, country = 'CN'): Promise<Track[]> => {
    const q = new URLSearchParams({ term, media: 'music', entity: 'song', limit: String(limit), country })
    const json = await jsonp(`https://itunes.apple.com/search?${q}`, 'callback')
    // 没有 preview 的条目对我们没用——放不出声的"搜到了"比没搜到更糟
    return (json?.results ?? []).map(toTrack).filter((t: Track) => t.preview)
  }

  return { search }
}

export type ItunesClient = ReturnType<typeof createItunesClient>
