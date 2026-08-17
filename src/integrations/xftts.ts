/**
 * 讯飞超拟人语音合成客户端（2026-08-16）。
 *
 * 选它不是音质最好——豆包才是——是它的鉴权把 HMAC-SHA256 签名放
 * **URL query** 里，浏览器 WebSocket 能直连：唯一穿得过「零后端」筛子的
 * 一线中文 TTS。豆包/阿里的 WS 鉴权都在 header，浏览器设不了。
 *
 * 用法：一句话术 = 一次 synthesize（status:2 一帧送全文），分帧收 mp3，
 * 收齐拼 Blob 交回去播。签名/帧构造/帧解析是纯函数，WS 编排薄薄一层。
 */

export const XF_ENDPOINT = 'wss://cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6'

/**
 * 免费档超拟人音色。value 带 xf: 前缀——跟系统音色同住一个下拉框，靠它分流。
 * 实测（2026-08-16 错误码 10163 附带的账号音色清单）：文档写的 x6_*_flow
 * 在实际账号里是 **x5_*_flow**；x6 系是 _pro 后缀、要在控制台单独开权限。
 */
export const XF_VOICES = [
  { value: 'xf:x5_lingxiaoxuan_flow', label: '聆小璇（讯飞云·女）' },
  { value: 'xf:x5_lingxiaoyue_flow', label: '聆小玥（讯飞云·女）' },
  { value: 'xf:x5_lingfeiyi_flow', label: '聆飞逸（讯飞云·男）' },
]

export const isCloudVoice = (name: string) => name.startsWith('xf:')
export const xfVcn = (name: string) => name.replace(/^xf:/, '')

/** 本地 rate（1 = 常速）→ 讯飞 speed 0-100（50 = 常速），越界夹住 */
export const xfSpeed = (rate: number) => Math.max(0, Math.min(100, Math.round(rate * 50)))

/** 待签串：讯飞规定的三行格式，date 用 RFC1123（toUTCString 即是） */
export const signOrigin = (host: string, date: string, path: string) =>
  `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`

/** 签名放 query：authorization = b64(api_key/algorithm/headers/signature 四元组) */
export function authUrl(endpoint: string, apiKey: string, sigB64: string, date: string): string {
  const u = new URL(endpoint.replace(/^wss:/, 'https:'))
  const auth = btoa(`api_key="${apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${sigB64}"`)
  return `${endpoint}?authorization=${encodeURIComponent(auth)}` +
    `&date=${encodeURIComponent(date)}&host=${u.host}`
}

const utf8b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** 请求帧：一句话术一帧送全（status 2），文本 base64，音频要 mp3 24k */
export function ttsFrame(appId: string, vcn: string, text: string, rate: number) {
  return {
    header: { app_id: appId, status: 2 },
    parameter: { tts: {
      vcn, speed: xfSpeed(rate), volume: 50, pitch: 50,
      audio: { encoding: 'lame', sample_rate: 24000 },
    } },
    payload: { text: { encoding: 'utf8', compress: 'raw', format: 'plain', status: 2, seq: 0, text: utf8b64(text) } },
  }
}

/** 响应帧 → 字节块/结束标/人话错误。WS 消息是外部输入，坏了不抛、按错误帧收场 */
export function parseFrame(raw: string): { chunk?: Uint8Array; done: boolean; error?: string } {
  let m: any
  try { m = JSON.parse(raw) } catch { return { done: true, error: '响应不是合法 JSON' } }
  const h = m?.header ?? {}
  if (h.code !== 0) return { done: true, error: `讯飞合成失败（${h.code}）：${h.message ?? '未知错误'}` }
  const a = m?.payload?.audio
  const chunk = a?.audio ? Uint8Array.from(atob(a.audio), c => c.charCodeAt(0)) : undefined
  return { chunk, done: h.status === 2 }
}

export interface XfCreds { appId: string; apiKey: string; apiSecret: string }

/**
 * 整句合成 → mp3 Blob。分帧收齐再交付（一句话术 <1s 就齐，不值得流式播）。
 * 8 秒总超时——云端挂了要快点让调用方回退本地音色，不是干等。
 */
export async function synthesize(creds: XfCreds, vcn: string, text: string, rate: number,
                                 timeoutMs = 8000): Promise<Blob> {
  const u = new URL(XF_ENDPOINT.replace(/^wss:/, 'https:'))
  const date = new Date().toUTCString()
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(creds.apiSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(signOrigin(u.host, date, u.pathname)))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))

  return new Promise<Blob>((resolve, reject) => {
    const ws = new WebSocket(authUrl(XF_ENDPOINT, creds.apiKey, sigB64, date))
    const chunks: Uint8Array[] = []
    const timer = setTimeout(() => { ws.close(); reject(new Error('讯飞合成超时')) }, timeoutMs)
    const fail = (e: unknown) => { clearTimeout(timer); ws.close(); reject(e instanceof Error ? e : new Error(String(e))) }
    ws.onopen = () => ws.send(JSON.stringify(ttsFrame(creds.appId, vcn, text, rate)))
    ws.onerror = () => fail(new Error('讯飞 WebSocket 连接失败'))
    ws.onmessage = ev => {
      const f = parseFrame(String(ev.data))
      if (f.error) return fail(new Error(f.error))
      if (f.chunk) chunks.push(f.chunk)
      if (f.done) {
        clearTimeout(timer); ws.close()
        if (!chunks.length) return reject(new Error('讯飞没有返回音频'))
        resolve(new Blob(chunks as BlobPart[], { type: 'audio/mpeg' }))
      }
    }
  })
}
