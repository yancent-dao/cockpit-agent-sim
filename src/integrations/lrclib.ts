/**
 * lrclib.net 歌词客户端（媒体卡重设计 v2 唯一新 CP）。
 *
 * 选它只有一个理由：**零 Key 零注册 + 官方 ACAO:***——file:// 单文件版
 * 直连也通，踩中本项目第一性约束（跟 Open-Meteo 同一条选型逻辑）。
 * search 比 get 宽容（实测精确 get 查不到周深《光亮》，search 能回 4 条）。
 *
 * 30 秒试听的已知取舍：LRC 时间戳是整曲的，iTunes 试听截自中段，
 * 逐句同步会错位——屏端按 position 直接对时间轴，接了全曲源自然就正了。
 */

interface LrclibResult {
  artistName: string
  trackName: string
  duration: number
  syncedLyrics: string | null
  plainLyrics?: string | null
}

/**
 * 挑选判据全是协议字段：有 syncedLyrics 才要（纯文本没法逐句）；
 * 传了时长就挑最接近的（同名翻唱/现场版靠它区分），没传取第一条 synced。
 */
export function pickLyrics(results: LrclibResult[], duration?: number): string | null {
  const synced = results.filter(r => r.syncedLyrics)
  if (!synced.length) return null
  if (!Number.isFinite(duration)) return synced[0].syncedLyrics
  return synced
    .slice()
    .sort((a, b) => Math.abs(a.duration - duration!) - Math.abs(b.duration - duration!))[0]
    .syncedLyrics
}

export function createLrclibClient(fetcher: typeof fetch, base: string) {
  return {
    /** "歌手 歌名" 拼 q 搜索，返回挑中的 LRC 文本；任何失败回 null——歌词不许拖垮播放 */
    async search(artist: string, track: string, durationSec?: number): Promise<string | null> {
      try {
        const q = encodeURIComponent(`${artist} ${track}`.trim())
        const res = await fetcher(`${base}/api/search?q=${q}`, { signal: AbortSignal.timeout(6000) } as any)
        if (!(res as any).ok) return null
        const list = await (res as any).json()
        return Array.isArray(list) ? pickLyrics(list, durationSec) : null
      } catch {
        return null
      }
    },
  }
}
