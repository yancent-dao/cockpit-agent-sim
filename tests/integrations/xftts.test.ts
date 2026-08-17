import { describe, it, expect } from 'vitest'
import {
  XF_ENDPOINT, XF_VOICES, isCloudVoice, xfVcn, xfSpeed,
  signOrigin, authUrl, ttsFrame, parseFrame,
} from '../../src/integrations/xftts'

/**
 * 讯飞超拟人语音合成（2026-08-16 选型）。选它不是音质最好——豆包才是——
 * 是它的鉴权把 HMAC 签名放 **URL query** 里，浏览器 WebSocket 能直连，
 * 唯一穿得过「零后端」筛子的一线中文 TTS。豆包/阿里的 WS 鉴权都在 header，
 * 浏览器设不了，接了就得加代理。
 *
 * 协议细节全部对着官方文档：wss 端点、RFC1123 date、
 * authorization = b64(api_key/algorithm/headers/signature 四元组)、
 * 文本 base64、音频 lame(mp3) 分帧 base64 回传、header.status 2 = 结束。
 */

describe('音色与标识', () => {
  it('云端音色带 xf: 前缀，isCloudVoice 靠它分流', () => {
    expect(XF_VOICES.length).toBeGreaterThanOrEqual(3)
    for (const v of XF_VOICES) expect(v.value.startsWith('xf:')).toBe(true)
    expect(isCloudVoice('xf:x6_lingxiaoxuan_flow')).toBe(true)
    expect(isCloudVoice('Tingting')).toBe(false)
  })
  it('xfVcn 剥掉前缀还原发音人参数', () => {
    expect(xfVcn('xf:x6_lingfeiyi_flow')).toBe('x6_lingfeiyi_flow')
  })
  it('xfSpeed：本地 rate(≈1) 映射到讯飞 0-100（50 为常速），越界夹住', () => {
    expect(xfSpeed(1)).toBe(50)
    expect(xfSpeed(0.92)).toBe(46)
    expect(xfSpeed(9)).toBe(100)
    expect(xfSpeed(-1)).toBe(0)
  })
})

describe('签名 URL', () => {
  it('signOrigin 拼出讯飞规定的三行待签串', () => {
    expect(signOrigin('cbm01.cn-huabei-1.xf-yun.com', 'Thu, 01 Aug 2019 01:53:21 GMT', '/v1/private/mcd9m97e6'))
      .toBe('host: cbm01.cn-huabei-1.xf-yun.com\ndate: Thu, 01 Aug 2019 01:53:21 GMT\nGET /v1/private/mcd9m97e6 HTTP/1.1')
  })
  it('authUrl 把四元组 b64 后放进 query —— 解回来逐字段核对', () => {
    const url = authUrl(XF_ENDPOINT, 'myKey', 'sigB64==', 'Thu, 01 Aug 2019 01:53:21 GMT')
    const u = new URL(url.replace('wss://', 'https://'))
    expect(u.host).toBe('cbm01.cn-huabei-1.xf-yun.com')
    expect(u.searchParams.get('host')).toBe('cbm01.cn-huabei-1.xf-yun.com')
    expect(u.searchParams.get('date')).toBe('Thu, 01 Aug 2019 01:53:21 GMT')
    const auth = atob(u.searchParams.get('authorization')!)
    expect(auth).toContain('api_key="myKey"')
    expect(auth).toContain('algorithm="hmac-sha256"')
    expect(auth).toContain('headers="host date request-line"')
    expect(auth).toContain('signature="sigB64=="')
  })
})

describe('请求帧', () => {
  it('一句话术一帧送全（status 2），中文文本 base64 无损来回', () => {
    const f = ttsFrame('app123', 'x6_lingxiaoxuan_flow', '空调已经调到二十四度了', 0.92)
    expect(f.header.app_id).toBe('app123')
    expect(f.header.status).toBe(2)
    expect(f.parameter.tts.vcn).toBe('x6_lingxiaoxuan_flow')
    expect(f.parameter.tts.speed).toBe(46)
    expect(f.parameter.tts.audio.encoding).toBe('lame')
    expect(f.payload.text.status).toBe(2)
    const back = new TextDecoder().decode(Uint8Array.from(atob(f.payload.text.text), c => c.charCodeAt(0)))
    expect(back).toBe('空调已经调到二十四度了')
  })
})

describe('响应帧', () => {
  it('音频帧解出字节，status 2 标记收齐', () => {
    const b64 = btoa(String.fromCharCode(1, 2, 3))
    const mid = parseFrame(JSON.stringify({ header: { code: 0, status: 1 }, payload: { audio: { audio: b64, status: 1 } } }))
    expect(Array.from(mid.chunk!)).toEqual([1, 2, 3])
    expect(mid.done).toBe(false)
    const end = parseFrame(JSON.stringify({ header: { code: 0, status: 2 }, payload: { audio: { audio: b64, status: 2 } } }))
    expect(end.done).toBe(true)
  })
  it('code 非 0 是错误帧：带人话信息，done 收场', () => {
    const r = parseFrame(JSON.stringify({ header: { code: 11200, message: 'auth failed', status: 2 } }))
    expect(r.error).toContain('11200')
    expect(r.done).toBe(true)
  })
  it('坏 JSON 不抛：按错误帧收场（WS 消息是外部输入）', () => {
    const r = parseFrame('not json')
    expect(r.error).toBeTruthy()
    expect(r.done).toBe(true)
  })
})
