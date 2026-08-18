import { describe, it, expect } from 'vitest'
import { pickLyrics, createLrclibClient } from '../../src/integrations/lrclib'

/**
 * lrclib.net 歌词 CP（媒体卡重设计 v2 唯一新 CP）：零 Key 零注册、官方 ACAO:*
 * （file:// 单文件版直连也通）。search 比 get 宽容（实测精确 get 查不到
 * 周深《光亮》，search 能回 4 条），挑选判据是协议字段：
 * 有 syncedLyrics 优先，时长与 iTunes 给的最接近者胜。
 */

const R = (artist: string, dur: number, synced: string | null) =>
  ({ artistName: artist, trackName: 'x', duration: dur, syncedLyrics: synced, plainLyrics: 'plain' })

describe('pickLyrics：挑 synced 且时长最近', () => {
  it('时长最接近的 synced 结果胜出', () => {
    const got = pickLyrics([R('a', 300, '[00:01.00]A'), R('b', 182, '[00:01.00]B'), R('c', 500, '[00:01.00]C')], 180)
    expect(got).toBe('[00:01.00]B')
  })
  it('没有 synced 的结果不要——纯文本歌词没法逐句', () => {
    expect(pickLyrics([R('a', 180, null)], 180)).toBeNull()
  })
  it('没传时长（电台/未知）就取第一条 synced', () => {
    const got = pickLyrics([R('a', 300, null), R('b', 200, '[00:01.00]B')], undefined)
    expect(got).toBe('[00:01.00]B')
  })
  it('空结果回 null', () => {
    expect(pickLyrics([], 180)).toBeNull()
  })
})

describe('client', () => {
  it('search 按"歌手 歌名"拼 q，返回挑中的 LRC', async () => {
    const calls: string[] = []
    const fetcher = async (url: string) => {
      calls.push(url)
      return { ok: true, json: async () => [R('周深', 289, '[00:12.00]也许世间所有的路')] } as any
    }
    const c = createLrclibClient(fetcher as any, 'https://lrclib.net')
    const lrc = await c.search('周深', '光亮', 289)
    expect(lrc).toContain('[00:12.00]')
    expect(calls[0]).toContain('/api/search')
    expect(calls[0]).toContain(encodeURIComponent('周深'))
  })
  it('网络失败回 null 不抛——歌词是锦上添花，不许拖垮播放', async () => {
    const c = createLrclibClient(async () => { throw new Error('boom') }, 'https://x')
    expect(await c.search('a', 'b', 100)).toBeNull()
  })
})
