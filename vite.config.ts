import { defineConfig } from 'vite'
import { resolve } from 'path'
import { proxyTable } from './src/config/upstream'

/**
 * 同源代理（2026-08-17）：上游表在 `src/config/upstream.ts`，这里只是把它
 * 摊成 Vite 的 proxy 配置。**加上游 = 改那张表，不改这个文件。**
 *
 * dev 与 preview 都配 —— 构建产物用 `npm run preview` 托管时同样免疫 CORS。
 */
const proxy = proxyTable()

export default defineConfig({
  build: { rollupOptions: { input: {
    main: resolve(__dirname, 'index.html'),
    screen: resolve(__dirname, 'screen.html'),
  } } },
  server: { proxy },
  preview: { proxy },
})
