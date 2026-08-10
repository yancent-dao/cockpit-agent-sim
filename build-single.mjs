import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

mkdirSync('single', { recursive: true })

for (const [entry, html, out] of [
  ['src/director/main.ts', 'index.html', 'single/座舱Demo_控制面板.html'],
  ['src/screen/main.ts',   'screen.html', 'single/screen.html'],
]) {
  const r = await build({
    entryPoints: [entry], bundle: true, format: 'iife', write: false,
    target: 'es2022', charset: 'utf8',
    define: { 'import.meta.env.VITE_OPENROUTER_KEY': '""' },
  })
  const js = r.outputFiles[0].text
  let page = readFileSync(html, 'utf8')
  page = page.replace(/<script type="module"[^>]*><\/script>/, () => `<script>\n${js.replace(/<\/script/gi, "<\\/script")}\n</script>`)
  writeFileSync(out, page)
  console.log(out, (page.length / 1024).toFixed(1) + ' KB')
}
