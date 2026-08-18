/**
 * 今日诗词（v1.jinrishici.com）。零 Key 零注册零 token，一次 fetch ——
 * 接入清单里成本最低的一个。开机问候、氛围灯场景的"人情味"素材。
 */
import { api } from '../config/upstream'

export interface Poem { content: string; origin: string; author: string }

export class PoemError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status?: number; json(): Promise<any> }>

export function createPoemClient(fetcher: Fetcher) {
  const today = async (): Promise<Poem> => {
    let res
    try { res = await fetcher(`${api('jinrishici')}/all.json`) }
    catch { throw new PoemError('诗词服务连不上', 'NETWORK') }
    if (!res.ok) throw new PoemError(`诗词服务返回 ${res.status}`, 'HTTP')
    const j = await res.json()
    if (!j?.content) throw new PoemError('诗词数据为空', 'DATA')
    return { content: String(j.content), origin: String(j.origin ?? ''), author: String(j.author ?? '') }
  }
  return { today }
}

export type PoemClient = ReturnType<typeof createPoemClient>
