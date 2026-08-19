/**
 * 豆包（火山引擎）TTS —— v3 单向流式 WebSocket（2026-08-19，讯飞免费额度耗尽后接入）。
 *
 * 端点 wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream，
 * 鉴权在 **WebSocket header**（X-Api-Key 等）——浏览器 WS 带不了自定义 header，
 * 这正是当年它被「零后端」挡在门外的原因。现在由 vite 同源代理注入：
 * 改 header、藏 Key 是代理层纪律明文允许的三件事之二，而且 Key 从此
 * 只在 node 侧，前端 bundle 一个字节都不沾（比讯飞的前端签名更干净）。
 * 代价如实记：file:// 单文件版没有代理，豆包音色在那个版本里不可用。
 *
 * 消息是火山二进制帧：4B 头 + [事件 4B] + [会话 len+str] + 载荷 len+载荷。
 * 编解码是纯函数（node 探针实测帧格式正确；403 只差控制台资源授权）。
 */
import { api } from '../config/upstream'

/* ── 帧编解码（纯函数，配测试） ── */

/** 客户端 full request：版本1/头长4B · full-client-request · JSON 无压缩 */
export function volcFrame(json: unknown): Uint8Array {
  const p = new TextEncoder().encode(JSON.stringify(json))
  const out = new Uint8Array(8 + p.length)
  out.set([0x11, 0x10, 0x10, 0x00])
  new DataView(out.buffer).setUint32(4, p.length)
  out.set(p, 8)
  return out
}

export interface VolcMsg {
  /** 0x9 FullServerResponse · 0xB AudioOnlyServer · 0xF Error */
  type: number
  event: number | null
  session: string
  code: number | null
  payload: Uint8Array
}

/** 服务端帧。事件号：150 SessionStarted · 152 SessionFinished · 350/351 句始末 · 352 音频 */
export function parseVolcFrame(buf: Uint8Array): VolcMsg {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const headerSize = (buf[0] & 0x0f) * 4
  const type = buf[1] >> 4
  const flags = buf[1] & 0x0f
  let o = headerSize
  let event: number | null = null, session = '', code: number | null = null
  if (type === 0xF) { code = dv.getUint32(o); o += 4 }
  if (flags & 0x4) {
    event = dv.getInt32(o); o += 4
    // connect/会话级控制事件（1/2/50/51/52）不带 session 段
    if (![1, 2, 50, 51, 52].includes(event)) {
      const sl = dv.getUint32(o); o += 4
      session = new TextDecoder().decode(buf.subarray(o, o + sl)); o += sl
    }
  }
  const pl = dv.getUint32(o); o += 4
  return { type, event, session, code, payload: buf.subarray(o, o + pl) }
}

/* ── 音色表（数据）：speaker 与资源号成对——1.0（moon）与 2.0（uranus）资源不同。
     以控制台「音色库」为准，缺谁补谁 = 表里加一行 ── */
export interface VolcVoice { value: string; label: string; speaker: string; resourceId: string }
const V = (speaker: string, label: string, res: string): VolcVoice =>
  ({ value: `volc:${speaker}`, label, speaker, resourceId: res })
export const VOLC_VOICES: VolcVoice[] = [
  V('zh_female_gaolengyujie_uranus_bigtts', '豆包2.0 · 高冷御姐', 'seed-tts-2.0'),
  V('zh_female_shuangkuaisisi_moon_bigtts', '豆包 · 爽快思思', 'volc.service_type.10029'),
  V('zh_male_yangguangqingnian_moon_bigtts', '豆包 · 阳光青年', 'volc.service_type.10029'),
  V('zh_female_wanwanxiaohe_moon_bigtts', '豆包 · 湾湾小何', 'volc.service_type.10029'),
]

export const isVolcVoice = (v: string) => v.startsWith('volc:')
export const volcSpeaker = (v: string): VolcVoice | undefined => VOLC_VOICES.find(x => x.value === v)

/**
 * 流式合成：连代理端点（Key/Request-Id 由代理注入；资源号经 query 带给代理，
 * 由它搬进 header——WS 带不了 header 的技术搬运，不是业务逻辑）。
 * 返回形状对齐 xftts.synthesizeStream：{ done, cancel }，音频块经 onChunk 交给 MSE。
 */
export function volcStream(voice: VolcVoice, text: string, rate: number,
  onChunk: (c: Uint8Array) => void, timeoutMs = 12000): { done: Promise<void>; cancel: () => void } {
  let ws: WebSocket | null = null
  let cancelled = false
  const done = (async () => {
    const base = api('volctts')   // http(s) 下是 /x/volctts，file:// 直连（会因 header 缺失失败——如实）
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = base.startsWith('/')
      ? `${scheme}://${location.host}${base}/api/v3/tts/unidirectional/stream?rid=${encodeURIComponent(voice.resourceId)}`
      : `${base}/api/v3/tts/unidirectional/stream`
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => { ws?.close(); rej(new Error('豆包连接超时')) }, 5000)
      ws!.onopen = () => { clearTimeout(t); res() }
      ws!.onerror = () => { clearTimeout(t); rej(new Error('豆包 WebSocket 连接失败（file:// 单文件版不支持豆包音色）')) }
    })
    // 语速映射：本地 rate 0.5~1.5 → 火山 speech_rate -50~100（1.0→0）
    const speechRate = Math.round(Math.max(-50, Math.min(100, (rate - 1) * 100)))
    ws.send(volcFrame({ req_params: {
      speaker: voice.speaker, text,
      audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: speechRate },
    } }))
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('豆包合成超时')), timeoutMs)
      ws!.onmessage = e => {
        const m = parseVolcFrame(new Uint8Array(e.data as ArrayBuffer))
        if (m.type === 0xB && m.payload.length) onChunk(m.payload)
        else if (m.type === 0xF) { clearTimeout(t); rej(new Error(`豆包合成失败(${m.code})：${new TextDecoder().decode(m.payload).slice(0, 120)}`)) }
        else if (m.event === 152) { clearTimeout(t); res() }
      }
      ws!.onerror = () => { clearTimeout(t); rej(new Error('豆包连接中断')) }
      ws!.onclose = () => { clearTimeout(t); cancelled ? res() : res() }
    })
    ws.close()
  })()
  return {
    done,
    cancel: () => { cancelled = true; try { ws?.close() } catch { /* 空 */ } },
  }
}
