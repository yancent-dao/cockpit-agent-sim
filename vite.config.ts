import { defineConfig } from 'vite'
import { resolve } from 'path'
import { proxyTable } from './src/config/upstream'
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
 */
const agent = envProxyAgent()
if (agent) for (const k of Object.keys(proxy)) proxy[k].agent = agent

export default defineConfig({
  build: { rollupOptions: { input: {
    main: resolve(__dirname, 'index.html'),
    screen: resolve(__dirname, 'screen.html'),
  } } },
  server: { proxy },
  preview: { proxy },
})
