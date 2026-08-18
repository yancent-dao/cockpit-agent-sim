/**
 * OpenRouter 音乐生成（Lyria 3）。不走专门端点——就是一次流式 chat：
 * modalities ['text','audio']，音频以 base64 分片从 delta.audio 流回
 * （官方文档确认的形态）。clip 档 30 秒 $0.04，跟绘本插图同一个账本。
 */
import { api } from '../config/upstream'

export class MusicGenError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export type Fetcher = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>

export const DEFAULT_MUSIC_MODEL = 'google/lyria-3-clip-preview'

/** SSE 全文 → base64 音频分片（纯函数，坏行跳过）。data: [DONE] 收尾 */
export function parseAudioSSE(sse: string): string[] {
  const out: string[] = []
  for (const line of sse.split('\n')) {
    const m = line.match(/^data:\s*(.+)$/)
    if (!m || m[1] === '[DONE]') continue
    try {
      const d = JSON.parse(m[1])?.choices?.[0]?.delta?.audio?.data
      if (typeof d === 'string' && d) out.push(d)
    } catch { /* 心跳/坏行跳过 */ }
  }
  return out
}

export function createMusicGen(fetcher: Fetcher, key: () => string, { timeoutMs = 90000 } = {}) {
  const generate = async (prompt: string, opts: { model?: string; instrumental?: boolean } = {}): Promise<Blob> => {
    if (!key()) throw new MusicGenError('没配 OpenRouter Key', 'NO_KEY')
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
    let res
    try {
      res = await fetcher(`${api('openrouter')}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model ?? DEFAULT_MUSIC_MODEL,
          modalities: ['text', 'audio'],
          stream: true,
          messages: [{ role: 'user', content: opts.instrumental ? `${prompt}（纯音乐，不要人声）` : prompt }],
        }),
        ...(ac && { signal: ac.signal }),
      })
    } catch { throw new MusicGenError('音乐服务连不上或超时', 'NETWORK') }
    finally { if (timer) clearTimeout(timer) }
    if (!res.ok) throw new MusicGenError(`音乐生成失败（${res.status}）`, 'HTTP')
    const chunks = parseAudioSSE(await res.text())
    if (!chunks.length) throw new MusicGenError('没收到音频数据', 'EMPTY')
    const bytes = chunks.map(b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)))
    return new Blob(bytes as BlobPart[], { type: 'audio/wav' })
  }
  return { generate }
}

export type MusicGenClient = ReturnType<typeof createMusicGen>
