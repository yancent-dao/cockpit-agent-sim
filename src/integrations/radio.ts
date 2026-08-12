/**
 * Radio Browser —— 社区维护的全球电台数据库。
 * 免费、无 Key、无注册，原生支持 CORS + HTTPS，是这批 CP 里最干净的一个。
 *
 * 一个绕不开的坑：同一个台常有 https 和 http 两条流（真实数据里就是这样）。
 * HTTPS 页面加载 http 流会被浏览器的 mixed content 拦掉——用户看到"已经在放了"
 * 但一点声音没有，比搜不到更糟。所以这里**只留 HTTPS**。
 */
import type { Fetcher } from './amap'

export interface Station {
  id: string
  name: string
  /** 已解析的流地址（Radio Browser 会自动处理 M3U/PLS 和 301 跳转） */
  url: string
  country: string
  language: string
  tags: string
  favicon: string
  codec: string
  bitrate: number
}

export class RadioError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export interface RadioQuery {
  name?: string
  tag?: string
  country?: string
  language?: string
  limit?: number
}

/**
 * 实测：主域名 api.radio-browser.info 直接返回 404，只有具体节点能用，
 * 而且节点会挂（fi1 当场就连不上）。官方推荐 DNS 查 all.api.radio-browser.info
 * 拿节点列表，但浏览器里做不了 DNS 查询，只能硬编码一组然后失败切换。
 */
const NODES = [
  'https://de1.api.radio-browser.info/json',
  'https://de2.api.radio-browser.info/json',
  'https://nl1.api.radio-browser.info/json',
  'https://at1.api.radio-browser.info/json',
]

export function createRadioClient(fetcher: Fetcher) {
  /** 上次成功的节点。大概率还活着，别每次都从头重试 */
  let preferred = 0

  /** 依次试各节点，任一成功即返回；全挂才抛 */
  async function viaNodes<T>(path: string): Promise<T> {
    const order = [...NODES.slice(preferred), ...NODES.slice(0, preferred)]
    let last: unknown
    for (const base of order) {
      try {
        const res = await fetcher(base + path)
        if (!res.ok) { last = new RadioError('节点没响应'); continue }
        preferred = NODES.indexOf(base)
        return await res.json()
      } catch (e) { last = e }
    }
    throw new RadioError(
      `电台服务连不上了（试了 ${NODES.length} 个节点）：${last instanceof Error ? last.message : ''}`,
      'ALL_NODES_DOWN',
    )
  }

  async function search(q: RadioQuery): Promise<Station[]> {
    const p = new URLSearchParams({
      limit: String(q.limit ?? 10),
      hidebroken: 'true',        // 挂掉的台不要
      order: 'clickcount',       // 热度排序，最可能能听的排前面
      reverse: 'true',
    })
    for (const k of ['name', 'tag', 'country', 'language'] as const)
      if (q[k]) p.set(k, q[k]!)

    const list = await viaNodes<any[]>(`/stations/search?${p}`)
    return (Array.isArray(list) ? list : [])
      .map((s: any): Station => ({
        id: s.stationuuid,
        name: s.name?.trim() ?? '',
        url: s.url_resolved ?? s.url ?? '',
        country: s.country ?? '',
        language: s.language ?? '',
        tags: s.tags ?? '',
        favicon: s.favicon ?? '',
        codec: s.codec ?? '',
        bitrate: Number(s.bitrate ?? 0),
      }))
      // 只留 HTTPS：http 流在 HTTPS 页面里会被静默拦掉，放不出声
      .filter(s => s.name && s.url.startsWith('https:'))
  }

  return { search }
}

export type RadioClient = ReturnType<typeof createRadioClient>
