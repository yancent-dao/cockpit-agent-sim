/**
 * Pexels 视频。免费注册、支持 CORS、竖版素材直链 mp4。
 *
 * 抖音/快手/B站的开放平台都要企业资质，个人注册不了；YouTube Data API
 * 支持 CORS 但国内访问不了。所以这是个人能拿到的唯一可用选项。
 *
 * 它是**素材库不是社交短视频**——没有推荐流、点赞、评论。车机场景本来
 * 就只有停车时能看，Demo 里能真播出一段就达到目的了。
 *
 * 实测国内 360p 档 3.1 秒出首帧，所以**默认取最小分辨率**：车机卡片
 * 本来就小，4K 档只会让首帧更慢。
 */
import type { Fetcher } from './amap'
import { api } from '../config/upstream'

export interface Clip {
  id: number
  title: string
  author: string
  /** 秒 */
  duration: number
  cover: string
  /** 直链 mp4，可以直接丢给 <video> */
  url: string
  width: number
  height: number
}

export class PexelsError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export function createPexelsClient(fetcher: Fetcher, key: () => string) {
  async function search(query: string, limit = 8): Promise<Clip[]> {
    const k = key()
    if (!k) throw new PexelsError('没配短视频服务的 Key', 'NO_KEY')
    const p = new URLSearchParams({
      query, per_page: String(limit),
      orientation: 'portrait',   // 竖版更像短视频
      size: 'small',
    })
    const res = await fetcher(`${api('pexels')}/videos/search?${p}`, { headers: { Authorization: k } })
    if (!res.ok) throw new PexelsError('短视频服务没响应', 'HTTP_ERROR')
    const json = await res.json()
    return (json.videos ?? []).map((v: any): Clip => {
      // 取最小的一档：车机卡片小，4K 只会让首帧更慢
      const file = [...(v.video_files ?? [])]
        .filter((f: any) => f.link && /mp4/i.test(f.file_type ?? 'mp4'))
        .sort((a: any, b: any) => (a.width ?? 0) - (b.width ?? 0))[0]
      return {
        id: v.id,
        // Pexels 没有标题字段，用 url 尾巴凑一个能念的名字
        title: String(v.url ?? '').replace(/\/$/, '').split('/').pop()?.replace(/-\d+$/, '').replace(/-/g, ' ') || '短视频',
        author: v.user?.name ?? '',
        duration: Number(v.duration ?? 0),
        cover: v.image ?? '',
        url: file?.link ?? '',
        width: file?.width ?? 0,
        height: file?.height ?? 0,
      }
    }).filter((c: Clip) => c.url)
  }

  return { search }
}

export type PexelsClient = ReturnType<typeof createPexelsClient>
