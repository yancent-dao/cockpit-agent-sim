import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'path'
import { proxyTable, ABROAD, PROXY_PREFIX } from './src/config/upstream'
// @ts-expect-error 纯 node 的 .mjs 帮手，不进浏览器 bundle
import { envProxyAgent } from './proxy-agent.mjs'

/**
 * 同源代理（2026-08-17）：上游表在 `src/config/upstream.ts`，这里只是把它
 * 摊成 Vite 的 proxy 配置。**加上游 = 改那张表，不改这个文件。**
 *
 * dev 与 preview 都配 —— 构建产物用 `npm run preview` 托管时同样免疫 CORS。
 */
const proxy: Record<string, any> = proxyTable()
/**
 * 转发层继承系统代理（HTTPS_PROXY）：浏览器直连本来就走它，
 * 转发不能比直连的网络环境差（实测：不带它 Google 系模型报 region 403、
 * newsapi 撞 DNS 污染——都是浏览器直连没有的问题）。
 * **只对出海上游挂**（ABROAD 白名单）：国内上游走 VPN 是降级——
 * 高德 IP 定位会定到代理节点头上（实拍：设置成都，天气卡显示杭州滨江）。
 */
const agent = envProxyAgent()
if (agent) for (const k of Object.keys(proxy))
  if (ABROAD.has(k.slice(PROXY_PREFIX.length) as any)) proxy[k].agent = agent

/**
 * 豆包 TTS 的 header 注入（转发层三件事之二：改 header、藏 Key）：
 * 鉴权在 WS header，浏览器带不了——X-Api-Key 从 env 注入（Key 只在 node 侧，
 * 前端 bundle 一个字节不沾）；资源号由客户端经 query 声明（?rid=...），
 * 代理只做 query→header 的技术搬运，不做任何内容判断。
 */
const volcKey = process.env.VITE_VOLC_TTS_KEY || loadEnv('development', __dirname, 'VITE_').VITE_VOLC_TTS_KEY || ''
if (proxy[PROXY_PREFIX + 'volctts']) proxy[PROXY_PREFIX + 'volctts'].configure = (p: any) => {
  p.on('proxyReqWs', (preq: any, req: any) => {
    const rid = new URL(req.url ?? '', 'http://x').searchParams.get('rid') || 'seed-tts-2.0'
    preq.setHeader('X-Api-Key', volcKey)
    preq.setHeader('X-Api-Resource-Id', rid)
    preq.setHeader('X-Api-Request-Id', Math.random().toString(36).slice(2) + Date.now().toString(36))
  })
}

export default defineConfig({
  build: { rollupOptions: { input: {
    main: resolve(__dirname, 'index.html'),
    screen: resolve(__dirname, 'screen.html'),
  } } },
  /**
   * strictPort（2026-08-19 用户点名"确保都在一个端口，避免遗留"）：
   * vite 默认端口被占会静默 +1 漂移（5173→5174→…），旧进程越积越多
   * 还不容易发现。锁死后被占直接报错——先杀旧的再起新的。
   * dev 恒 5173、preview 恒 4173。
   */
  server: { proxy, strictPort: true },
  preview: { proxy, strictPort: true },
})
