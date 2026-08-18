/**
 * OpenRouter 视频生成（POST /api/v1/videos，2026 已 GA）。
 *
 * 一个端点聚合 Seedance / Veo / 可灵 / 海螺 / Sora——换模型 = 换 slug 字符串。
 * 跟绘本插图（orimage）同一个 host、同一个 Key、同一个账本：多接一家服务商
 * 要多一把 Key 一套鉴权，换不来任何东西。
 *
 * 异步任务：提交拿 id → 轮询 GET /videos/{id} → completed 后 unsigned_urls[0]
 * 就是 mp4 直链（官方文档确认，无 base64）。默认 seedance：清单里的推荐档，
 * $0.13–0.26 / 5 秒。
 */
import { api } from '../config/upstream'

export interface VideoJob { url: string }

export class VideoGenError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export type Fetcher = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json(): Promise<any> }>

export const DEFAULT_VIDEO_MODEL = 'bytedance/seedance-1.5-pro'

export function createVideoGen(fetcher: Fetcher, key: () => string,
                               { pollMs = 5000, maxWaitMs = 180000 } = {}) {
  const headers = () => ({ Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' })

  const generate = async (prompt: string, opts: { model?: string; duration?: number; ratio?: string }): Promise<VideoJob> => {
    if (!key()) throw new VideoGenError('没配 OpenRouter Key', 'NO_KEY')
    const res = await fetcher(`${api('openrouter')}/api/v1/videos`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_VIDEO_MODEL, prompt,
        ...(opts.duration && { duration: opts.duration }),
        ...(opts.ratio && { aspect_ratio: opts.ratio }),
      }),
    })
    if (!res.ok) throw new VideoGenError(`视频任务没提交上（${res.status}）`, 'SUBMIT')
    const { id } = await res.json()
    if (!id) throw new VideoGenError('视频服务没返回任务号', 'NO_ID')

    const t0 = Date.now()
    for (;;) {
      await new Promise(r => setTimeout(r, pollMs))
      if (Date.now() - t0 > maxWaitMs) throw new VideoGenError('视频生成超时了', 'TIMEOUT')
      const poll = await fetcher(`${api('openrouter')}/api/v1/videos/${id}`, { headers: headers() })
      if (!poll.ok) continue   // 单次轮询失败不放弃，超时兜底
      const j = await poll.json()
      if (j.status === 'completed') {
        const url = j.unsigned_urls?.[0]
        if (!url) throw new VideoGenError('生成完了但没拿到视频地址', 'NO_URL')
        return { url }
      }
      if (j.status === 'failed')
        throw new VideoGenError(`视频生成失败：${j.error?.message ?? '服务端未说明原因'}`, 'FAILED')
    }
  }

  return { generate }
}

export type VideoGenClient = ReturnType<typeof createVideoGen>
