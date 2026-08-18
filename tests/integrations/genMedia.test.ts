import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createVideoGen, type VideoJob } from '../../src/integrations/orvideo'
import { createMusicGen, parseAudioSSE } from '../../src/integrations/ormusic'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * OpenRouter 白捡批（接入清单梯队 01）：视频生成与音乐生成。
 * 同一个 host、同一个 Key、跟绘本插图同一个账本——多接一家服务商要
 * 多一把 Key 一套鉴权，换不来任何东西（orimage 立下的判据）。
 *
 * 视频：POST /api/v1/videos 异步 → 轮询 GET /videos/{id} → unsigned_urls。
 * 音乐：Lyria 走流式 chat 的 delta.audio base64 分片（官方文档确认的形态）。
 */

describe('视频生成客户端', () => {
  it('提交 → 轮询 → completed 拿 unsigned_urls', async () => {
    const calls: string[] = []
    let polls = 0
    const f = async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (init?.method === 'POST') return { ok: true, json: async () => ({ id: 'job1' }) } as any
      polls++
      return { ok: true, json: async () => (polls < 2
        ? { status: 'in_progress' }
        : { status: 'completed', unsigned_urls: ['https://cdn.x/v.mp4'] }) } as any
    }
    const c = createVideoGen(f as any, () => 'k', { pollMs: 1, maxWaitMs: 5000 })
    const r = await c.generate('海边的狗', { model: 'bytedance/seedance-1.5-pro' })
    expect(calls[0]).toContain('POST')
    expect(calls[0]).toContain('/videos')
    expect(r.url).toBe('https://cdn.x/v.mp4')
  })
  it('failed 状态给人话错误', async () => {
    const f = async (url: string, init?: any) => init?.method === 'POST'
      ? { ok: true, json: async () => ({ id: 'j' }) } as any
      : { ok: true, json: async () => ({ status: 'failed', error: { message: 'content policy' } }) } as any
    const c = createVideoGen(f as any, () => 'k', { pollMs: 1 })
    await expect(c.generate('x', {})).rejects.toThrow(/生成失败/)
  })
})

describe('音乐生成：SSE 音频分片解析（纯函数）', () => {
  it('data: 行里的 delta.audio.data 逐片收齐，[DONE] 停', () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: 'AAA=' } } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '写好了' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: 'BBB=' } } }] })}`,
      'data: [DONE]',
    ].join('\n\n')
    expect(parseAudioSSE(sse)).toEqual(['AAA=', 'BBB='])
  })
  it('坏 JSON 行跳过不炸', () => {
    expect(parseAudioSSE('data: {bad\n\ndata: [DONE]')).toEqual([])
  })
})

describe('video.generate / music.generate（handler 层）', () => {
  let store: ReturnType<typeof createStore>
  beforeEach(() => { store = createStore(SIGNALS, CONSTRAINTS) })

  it('video.generate：立即返回"在生成"，完成后自动接管播放（停车时）', async () => {
    const orvideo = { generate: async () => ({ url: 'https://cdn.x/gen.mp4' }) }
    const r = createRegistry(store, TOOLS, Date.now, { orvideo } as any)
    const res = await r.invoke('video.generate', { prompt: '海边的狗' })
    expect(res.status).toBe('ok')
    expect(res.message).toMatch(/生成|稍等/)
    await new Promise(rr => setTimeout(rr, 5))   // 后台完成回调落地
    expect(store.get('media.source')).toBe('video')
    expect(String(store.get('media.streamUrl'))).toContain('gen.mp4')
  })

  it('music.generate：整段音频进播放器', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake-url' })
    const ormusic = { generate: async () => new Blob([new Uint8Array([1])], { type: 'audio/wav' }) }
    const r = createRegistry(store, TOOLS, Date.now, { ormusic } as any)
    const res = await r.invoke('music.generate', { prompt: '给妞妞的生日歌' })
    vi.unstubAllGlobals()
    expect(res.status).toBe('ok')
    expect(store.get('media.source')).toBe('music')
    expect(store.get('media.playing')).toBe(true)
    expect(String(store.get('media.track'))).toContain('妞妞')
  })
})
