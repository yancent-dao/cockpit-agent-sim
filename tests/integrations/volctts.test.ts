import { describe, it, expect } from 'vitest'
import { volcFrame, parseVolcFrame, VOLC_VOICES, isVolcVoice, volcSpeaker } from '../../src/integrations/volctts'

/**
 * 豆包（火山）TTS v3 单向流式：二进制帧协议的编解码是纯函数。
 * 鉴权在 WebSocket header——浏览器带不了，由 vite 代理注入（改 header、
 * 藏 Key 正是代理层纪律明文允许的三件事之二）。node 探针已实测：
 * 帧格式正确、Key 通道通（403 只差控制台资源授权）。
 */

describe('volcFrame：客户端 full request 帧', () => {
  it('4 字节头 + 大端长度 + JSON 载荷', () => {
    const f = volcFrame({ a: 1 })
    expect(f[0]).toBe(0x11)   // 版本1 · 头长1×4
    expect(f[1]).toBe(0x10)   // full client request · 无 flags
    expect(f[2]).toBe(0x10)   // JSON 序列化 · 无压缩
    const len = new DataView(f.buffer).getUint32(4)
    expect(len).toBe(f.length - 8)
    expect(new TextDecoder().decode(f.slice(8))).toBe('{"a":1}')
  })
})

describe('parseVolcFrame：服务端帧', () => {
  const build = (type: number, flags: number, opts: { event?: number; session?: string; payload?: Uint8Array; code?: number } = {}) => {
    const parts: number[] = [0x11, (type << 4) | flags, 0x10, 0x00]
    const push32 = (n: number) => { parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255) }
    if (opts.code !== undefined) push32(opts.code)
    if (opts.event !== undefined) push32(opts.event)
    if (opts.session !== undefined) {
      push32(opts.session.length)
      for (const ch of new TextEncoder().encode(opts.session)) parts.push(ch)
    }
    const p = opts.payload ?? new Uint8Array(0)
    push32(p.length)
    return new Uint8Array([...parts, ...p])
  }

  it('AudioOnlyServer（0xB）带 event 与 session：载荷是音频', () => {
    const audio = new Uint8Array([1, 2, 3, 4])
    const m = parseVolcFrame(build(0xB, 0x4, { event: 352, session: 'abc', payload: audio }))
    expect(m.type).toBe(0xB)
    expect(m.event).toBe(352)
    expect([...m.payload]).toEqual([1, 2, 3, 4])
  })

  it('FullServerResponse（0x9）SessionFinished 事件', () => {
    const m = parseVolcFrame(build(0x9, 0x4, { event: 152, session: 's1', payload: new TextEncoder().encode('{}') }))
    expect(m.event).toBe(152)
  })

  it('Error（0xF）帧带错误码，载荷是错误文本', () => {
    const m = parseVolcFrame(build(0xF, 0x0, { code: 45000001, payload: new TextEncoder().encode('bad') }))
    expect(m.type).toBe(0xF)
    expect(m.code).toBe(45000001)
    expect(new TextDecoder().decode(m.payload)).toBe('bad')
  })
})

describe('音色表', () => {
  it('每个音色带 speaker 与资源号（1.0/2.0 资源不同）', () => {
    expect(VOLC_VOICES.length).toBeGreaterThan(2)
    for (const v of VOLC_VOICES) {
      expect(v.value.startsWith('volc:')).toBe(true)
      expect(v.speaker).toBeTruthy()
      expect(v.resourceId).toBeTruthy()
    }
  })
  it('isVolcVoice / volcSpeaker 按前缀识别', () => {
    const v = VOLC_VOICES[0]
    expect(isVolcVoice(v.value)).toBe(true)
    expect(isVolcVoice('x6_lingxiaoxuan_pro')).toBe(false)
    expect(volcSpeaker(v.value)?.speaker).toBe(v.speaker)
  })
})
