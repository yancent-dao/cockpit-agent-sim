/**
 * 让 vite 的转发代理认系统代理（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY）。
 *
 * 为什么必须有（2026-08-18 实测）：浏览器和 curl 都走系统代理（本机 VPN），
 * 而 Node 的 http-proxy **不认环境变量**——转发层用真实出口 IP 直连上游，
 * 于是 Google 系模型报 "not available in your region"、newsapi 撞 DNS 污染。
 * 同源代理不能比浏览器直连的网络环境更差，否则接管道等于降级。
 *
 * 两种隧道都自己写（「少于 200 行就自己写」）：
 * - http://  → HTTP CONNECT 隧道
 * - socks5:// / socks:// → SOCKS5 CONNECT（v2ray 的 10808 就是它）
 * 另有一条**自动回退**：env 写着 http:// 但端口实际说的是 socks5
 * （v2rayN 用户的常见误配，2026-08-18 实拍：CONNECT 打到 socks 端口上，
 * 连接被闷掉，慢层 403 锁区），HTTP CONNECT 失败就换 socks5 再试一次。
 *
 * 没设环境代理时返回 undefined，零影响。
 * 这是 node 侧的构建配置，不进浏览器 bundle，不占任何代码预算。
 */
import net from 'node:net'
import tls from 'node:tls'
import https from 'node:https'

/** HTTP CONNECT 隧道。ok(tlsSocket) / fail(err, rawClosed)——rawClosed 供回退判断 */
function httpTunnel(u, host, port, ok, fail) {
  const sock = net.connect({ host: u.hostname, port: Number(u.port) || 8080 }, () => {
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
  })
  let buf = '', settled = false
  const onData = d => {
    buf += d.toString('latin1')
    if (!buf.includes('\r\n\r\n')) return
    sock.off('data', onData)
    settled = true
    if (!/^HTTP\/1\.[01] 200/.test(buf)) {
      sock.destroy()
      return fail(new Error(`系统代理 CONNECT 失败：${buf.split('\r\n')[0]}`), false)
    }
    ok(tls.connect({ socket: sock, servername: host }))
  }
  sock.on('data', onData)
  // socks 端口收到 "CONNECT..." 会当成坏握手直接闭连——这就是要回退的信号
  sock.once('close', () => { if (!settled) fail(new Error('代理端口无 HTTP 响应即关闭'), true) })
  sock.once('error', e => { if (!settled) { settled = true; fail(e, false) } })
}

/** SOCKS5 CONNECT 隧道（无鉴权）。协议就三步：greeting → connect → 通 */
function socksTunnel(u, host, port, ok, fail) {
  const sock = net.connect({ host: u.hostname, port: Number(u.port) || 1080 }, () => {
    sock.write(Buffer.from([5, 1, 0]))
  })
  let buf = Buffer.alloc(0), stage = 0
  const onData = d => {
    buf = Buffer.concat([buf, d])
    if (stage === 0) {
      if (buf.length < 2) return
      if (buf[0] !== 5 || buf[1] !== 0) { sock.destroy(); return fail(new Error('socks5 握手被拒')) }
      buf = buf.subarray(2); stage = 1
      const h = Buffer.from(host)
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h,
        Buffer.from([(port >> 8) & 255, port & 255])]))
      if (!buf.length) return
    }
    if (stage === 1) {
      if (buf.length < 5) return
      if (buf[1] !== 0) { sock.destroy(); return fail(new Error(`socks5 CONNECT 被拒（code ${buf[1]}）`)) }
      // 回包带绑定地址，按 ATYP 消费完整长度再交管道
      const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4]
      if (buf.length < need) return
      sock.off('data', onData)
      ok(tls.connect({ socket: sock, servername: host }))
    }
  }
  sock.on('data', onData)
  sock.once('error', e => fail(e))
}

let warnedFallback = false

/**
 * @param {string} [fallbackUrl] 环境变量都没有时的兜底代理地址。
 *   2026-08-25 实拍：dev server 在没 export HTTPS_PROXY 的终端里启动，
 *   出口直连 CN，慢层 Claude Opus 403 锁区——用户每换一个终端就要
 *   记得 export 一次是个坑。vite.config 会把 .env.local 的 PROXY_URL
 *   传进来（无 VITE_ 前缀，不进前端 bundle），从此在哪个终端启动都带代理。
 */
export function envProxyAgent(fallbackUrl) {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || fallbackUrl
  if (!raw) return undefined
  let u
  try { u = new URL(raw) } catch { return undefined }
  const isSocks = u.protocol === 'socks5:' || u.protocol === 'socks:'

  class TunnelAgent extends https.Agent {
    createConnection(opts, cb) {
      const host = opts.host
      const port = opts.port || 443
      const ok = s => cb(null, s)
      if (isSocks) return socksTunnel(u, host, port, ok, e => cb(e))
      httpTunnel(u, host, port, ok, (e, rawClosed) => {
        if (!rawClosed) return cb(e)
        // 端口不说 HTTP——很可能是 socks5（v2ray 10808 误配成 http://），换个话再敲一次
        if (!warnedFallback) {
          warnedFallback = true
          console.warn(`[proxy] ${u.host} 不认 HTTP CONNECT，按 socks5 重试成功的话，` +
            `建议把环境变量改成 socks5://${u.host} 更直白`)
        }
        socksTunnel(u, host, port, ok, e2 => cb(e2))
      })
    }
  }
  return new TunnelAgent({ keepAlive: true })
}
