/**
 * 三方上游表 —— 同源代理与直连的单一事实来源。
 *
 * **为什么有这个文件**（2026-08-17 产品决策：去掉 CORS 这道墙）：
 * CORS 不是我们的规则，是浏览器的；我们的规则是「零后端」，是它逼着只能挑
 * 开了 CORS 的服务。代价很具体 —— iTunes 被迫走 40 行 JSONP、联网搜索绕一圈
 * 走 LLM（Tavily/Brave 故意关 CORS）、豆包/阿里 TTS 因为 WebSocket 鉴权在
 * header 而**完全接不进来**、Key 只能明文打进前端 bundle。
 *
 * 解法的形态是 **Vite 自带的 dev/preview proxy**：零新增依赖、零后端代码、
 * 构建产物仍是静态文件。「零后端」这条硬约束因此精确化为「零后端**产物**」——
 * 不要服务端业务逻辑、不要数据库、不要 Docker、不要部署运维；开发服务器做
 * 纯转发不算后端。
 *
 * **纪律：代理层里不许有业务逻辑。** 它只做三件事 —— 转发、改 header、藏 Key。
 * 出现内容判断、拼业务参数、解析响应就是违规，那些归 `src/integrations/`。
 * 这跟「Tools = 机制」同源：转发是机制，业务是别人的事。
 *
 * 加一个上游 = 这张表加一行（vite.config.ts 自动生成转发规则）。
 */

/** 代理路径前缀。`/x/` 短、且不跟 index/screen/gallery/src 任何业务路由撞 */
export const PROXY_PREFIX = '/x/'

/** 上游 origin 表。只写 origin，路径由各自的 client 拼 */
export const UPSTREAM = {
  itunes: 'https://itunes.apple.com',
  amap: 'https://restapi.amap.com',
  openmeteo: 'https://api.open-meteo.com',
  newsapi: 'https://newsapi.org',
  pexels: 'https://api.pexels.com',
  openrouter: 'https://openrouter.ai',
  radio: 'https://de1.api.radio-browser.info',
  /** 讯飞 TTS 是 WebSocket —— proxy 的 ws:true 一并转发，未来接 header 鉴权的 CP 靠它 */
  xftts: 'wss://cbm01.cn-huabei-1.xf-yun.com',
} as const

export type Upstream = keyof typeof UPSTREAM

/** Vite 的 server.proxy / preview.proxy 配置。纯转发，一行业务逻辑都没有 */
export function proxyTable() {
  return Object.fromEntries(
    Object.entries(UPSTREAM).map(([k, target]) => [PROXY_PREFIX + k, {
      target,
      changeOrigin: true,   // 不改 Origin，上游会按跨域拒
      ws: true,             // WebSocket 上游（讯飞 TTS）也走这条
      rewrite: (p: string) => p.replace(PROXY_PREFIX + k, ''),
    }]),
  ) as Record<string, { target: string; changeOrigin: boolean; ws: boolean; rewrite?: (p: string) => string }>
}

/**
 * 这个上游的 base URL。
 *
 * 判据是**协议**而不是 `import.meta.env`：后者在 vite.config.ts 被编译成 CJS
 * 时是语法错误（这个文件要被 config 和运行时同时 import），而协议判据更本质 ——
 * http(s) 下有 dev/preview server 在转发，`file://`（单文件版双击打开）没有。
 *
 * 注意：`vite build` 的产物若托管在不提供 `/x/*` 转发的服务器上（nginx、
 * python -m http.server），代理路径会 404 —— 用 `npm run preview`，它自带转发。
 */
export function api(name: Upstream, protocol = typeof location === 'undefined' ? 'file:' : location.protocol): string {
  return protocol.startsWith('http') ? PROXY_PREFIX + name : UPSTREAM[name]
}
