/**
 * 让 vite 的转发代理认系统代理（HTTPS_PROXY / HTTP_PROXY）。
 *
 * 为什么必须有（2026-08-18 实测）：浏览器和 curl 都走系统代理（本机 VPN），
 * 而 Node 的 http-proxy **不认环境变量**——转发层用真实出口 IP 直连上游，
 * 于是 Google 系模型报 "not available in your region"、newsapi 撞 DNS 污染。
 * 同源代理不能比浏览器直连的网络环境更差，否则接管道等于降级。
 *
 * 标准做法是装 https-proxy-agent，但那要加依赖——CONNECT 隧道自己写只要
 * 这几十行（「少于 200 行就自己写」）。没设环境代理时返回 undefined，零影响。
 *
 * 这是 node 侧的构建配置，不进浏览器 bundle，不占任何代码预算。
 */
import net from 'node:net'
import tls from 'node:tls'
import https from 'node:https'

export function envProxyAgent() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (!raw) return undefined
  let u
  try { u = new URL(raw) } catch { return undefined }

  class TunnelAgent extends https.Agent {
    createConnection(opts, cb) {
      const host = opts.host
      const port = opts.port || 443
      const sock = net.connect({ host: u.hostname, port: Number(u.port) || 8080 }, () => {
        sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      })
      let buf = ''
      const onData = d => {
        buf += d.toString('latin1')
        if (!buf.includes('\r\n\r\n')) return
        sock.off('data', onData)
        if (!/^HTTP\/1\.[01] 200/.test(buf)) {
          sock.destroy()
          return cb(new Error(`系统代理 CONNECT 失败：${buf.split('\r\n')[0]}`))
        }
        cb(null, tls.connect({ socket: sock, servername: host }))
      }
      sock.on('data', onData)
      sock.once('error', e => cb(e))
    }
  }
  return new TunnelAgent({ keepAlive: true })
}
