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
 * 音色清单对齐账号控制台的「已开通」页（2026-08-16 逐个真调验证，7/7 通）。
 * 讯飞的音色授权是**按账号**的：schema 里合法 ≠ 你能用，没开通的报 11200
 * licc limit —— 车机屏的回退横幅会把这个说出来。换账号如果清单不同，
 * 改这里就行（数据不是代码）。x6 _pro 系音质高于 x5 _flow 系。
 */
export const XF_VOICES = [
  { value: 'xf:x6_lingxiaoxuan_pro', label: '聆小璇（讯飞云·女）' },
  { value: 'xf:x6_lingxiaoyue_pro', label: '聆小玥（讯飞云·女）' },
  { value: 'xf:x6_lingyuyan_pro', label: '聆玉言（讯飞云·女）' },
  { value: 'xf:x5_lingxiaotang_flow', label: '聆小糖（讯飞云·女）' },
  { value: 'xf:x5_lingyuzhao_flow', label: '聆玉昭（讯飞云·女）' },
  { value: 'xf:x6_lingfeiyi_pro', label: '聆飞逸（讯飞云·男）' },
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

async function signedUrl(creds: XfCreds): Promise<string> {
  const u = new URL(XF_ENDPOINT.replace(/^wss:/, 'https:'))
  const date = new Date().toUTCString()
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(creds.apiSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(signOrigin(u.host, date, u.pathname)))
  return authUrl(XF_ENDPOINT, creds.apiKey, btoa(String.fromCharCode(...new Uint8Array(sig))), date)
}

/**
 * 直连 wss URL → 同源代理 URL（/x/xftts，vite proxy ws:true 转发）。
 * 签名**仍对上游 host 算**——changeOrigin 会把 Host 改回 cbm01，上游按它验签。
 * WebSocket 本身没有 CORS，讯飞直连也通；走代理是为了把 ws 通道跑热
 * （将来豆包这类 header 鉴权的 CP 只有这条路），所以带直连回退，不赌。
 */
export function proxiedWsUrl(direct: string): string {
  const u = new URL(direct.replace(/^wss:/, 'https:'))
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/x/xftts${u.pathname}${u.search}`
}

async function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  const ws = new WebSocket(url)
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => { ws.close(); rej(new Error('讯飞连接超时')) }, timeoutMs)
    ws.onopen = () => { clearTimeout(t); res() }
    ws.onerror = () => { clearTimeout(t); rej(new Error('讯飞 WebSocket 连接失败')) }
  })
  return ws
}

async function openSocket(creds: XfCreds): Promise<WebSocket> {
  const direct = await signedUrl(creds)
  // http(s) 页面先试同源代理；代理不在（server 没重启/纯静态托管）回退直连
  if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    try { return await connect(proxiedWsUrl(direct), 4000) } catch { /* 回退直连 */ }
  }
  return connect(direct, 6000)
}

/**
 * 预热池（一格）。实测建连要 1.5-2.2 秒、而空闲 8 秒后连接依然可用发帧 ——
 * 模型思考时先把连接建好，建连时间整个藏进 LLM 延迟里。
 * 预热失败静默：它只是加速，正式合成会自己现开。
 */
let warmSlot: Promise<WebSocket> | null = null
export function warm(creds: XfCreds): void {
  if (warmSlot) return
  const p = openSocket(creds)
  warmSlot = p
  p.then(ws => { ws.onclose = () => { if (warmSlot === p) warmSlot = null } })
    .catch(() => { if (warmSlot === p) warmSlot = null })
}
async function takeSocket(creds: XfCreds): Promise<WebSocket> {
  const w = warmSlot; warmSlot = null
  if (w) {
    try { const ws = await w; if (ws.readyState === WebSocket.OPEN) return ws } catch { /* 预热失败就现开 */ }
  }
  return openSocket(creds)
}

/**
 * 流式合成：mp3 帧到一帧回调一帧。实测一句 28 字的话 40 帧收齐要 5-6 秒，
 * 而首帧 0.5 秒就到 —— 攒齐再播等于白等 3 秒以上。
 */
export function synthesizeStream(creds: XfCreds, vcn: string, text: string, rate: number,
                                 onChunk: (c: Uint8Array) => void, timeoutMs = 15000):
                                 { done: Promise<void>; cancel: () => void } {
  let sock: WebSocket | null = null
  let cancelled = false
  const done = (async () => {
    const ws = await takeSocket(creds)
    if (cancelled) { ws.close(); return }
    sock = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('讯飞合成超时')) }, timeoutMs)
      const fail = (e: Error) => { clearTimeout(timer); ws.close(); reject(e) }
      ws.onerror = () => fail(new Error('讯飞 WebSocket 连接失败'))
      ws.onclose = () => { if (cancelled) { clearTimeout(timer); resolve() } }
      ws.onmessage = ev => {
        const f = parseFrame(String(ev.data))
        if (f.error) return fail(new Error(f.error))
        if (f.chunk) onChunk(f.chunk)
        if (f.done) { clearTimeout(timer); ws.close(); resolve() }
      }
      ws.send(JSON.stringify(ttsFrame(creds.appId, vcn, text, rate)))
    })
  })()
  return { done, cancel: () => { cancelled = true; sock?.close() } }
}

/** 整句合成 → mp3 Blob（绘本、试听用——那两处等得起，也要拿总时长校准节奏） */
export async function synthesize(creds: XfCreds, vcn: string, text: string, rate: number,
                                 timeoutMs = 12000): Promise<Blob> {
  const chunks: Uint8Array[] = []
  await synthesizeStream(creds, vcn, text, rate, c => chunks.push(c), timeoutMs).done
  if (!chunks.length) throw new Error('讯飞没有返回音频')
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
}
