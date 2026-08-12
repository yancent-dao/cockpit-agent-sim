/**
 * 生成式卡的消毒器 —— 这是**安全边界，不是可选项**。
 *
 * 生成式卡让模型直出 HTML，是整个系统里唯一一处「把模型输出当代码执行」的地方。
 *
 * ## 为什么不用 DOMParser
 *
 * 上游设计写的是 DOMParser。它在浏览器里可用，但测试跑在 Node 里没有 DOM，
 * 而装 jsdom 会破掉「运行时依赖为零」。按 CLAUDE.md 的判据（少于 200 行就自己写），
 * 这里手写一个 tokenizer。
 *
 * ## 为什么是「解析 + 重新序列化」而不是正则替换
 *
 * 正则消毒是经典反模式：`<scr<script>ipt>` 这类嵌套、属性里的引号、
 * 大小写变形、编码变形，正则永远补不完 —— 每补一条就是承认上一条漏了。
 *
 * 这里走的是 **fail-closed**：把输入解析成标签与属性，**只把白名单里的东西
 * 重新写出来**。任何我没理解的构造根本不会出现在输出里，
 * 因为输出是我自己拼的，不是在原文上修修补补。
 */

/** 连内容一起丢。这些标签的文本本身就是攻击载荷（脚本体、样式体） */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript',
  'form', 'input', 'button', 'select', 'textarea', 'option',
  'link', 'meta', 'base', 'template', 'title', 'head',
])

/** 放行的标签。不在这里的丢标签、留文字 —— <a> 没了但那句话还在 */
const ALLOW = new Set([
  'div', 'span', 'p', 'b', 'i', 'em', 'strong', 'small', 'h4', 'h5',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'br', 'hr', 'img', 'figure', 'figcaption', 'code',
  // SVG 全族：图表画不出来的话模型就只能堆文字
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'use',
])

/** 大小写敏感的 SVG 标签/属性，序列化时要还原 —— 写成 viewbox 的话 SVG 直接不渲染 */
const CASE: Record<string, string> = {
  lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath',
  viewbox: 'viewBox', gradientunits: 'gradientUnits', 'stroke-width': 'stroke-width',
  'stop-color': 'stop-color', 'text-anchor': 'text-anchor',
  'font-size': 'font-size', 'font-weight': 'font-weight', 'stroke-linecap': 'stroke-linecap',
  'stroke-dasharray': 'stroke-dasharray', 'fill-opacity': 'fill-opacity',
  'stroke-opacity': 'stroke-opacity', 'dominant-baseline': 'dominant-baseline',
  preserveaspectratio: 'preserveAspectRatio',
}

const ATTR = new Set([
  'class', 'style', 'width', 'height', 'viewbox', 'd', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-dasharray', 'fill-opacity', 'stroke-opacity',
  'opacity', 'transform', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'points',
  'offset', 'stop-color', 'gradientunits', 'x1', 'y1', 'x2', 'y2',
  'text-anchor', 'dominant-baseline', 'font-size', 'font-weight',
  'alt', 'src', 'colspan', 'rowspan', 'preserveaspectratio',
])

/** 无闭合标签 */
const VOID = new Set(['br', 'hr', 'img'])

/**
 * style 值里禁掉的东西：
 *   url(      能发外部请求，等于一个不受控的信标
 *   expression / @import  老 IE 的脚本执行路径，成本低不如一起挡
 *   position:fixed/sticky 能逃出卡片盖住整屏 —— 卡片必须待在自己的格子里
 */
const CSS_BAN = /url\s*\(|expression\s*\(|@import|position\s*:\s*(fixed|sticky)/i

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function cleanStyle(v: string): string {
  return v.split(';')
    .map(d => d.trim())
    .filter(d => d && !CSS_BAN.test(d))
    .join(';')
}

/** src 只放行 https 与内嵌图片。data:text/html 是一整个页面，绝不放行 */
function cleanSrc(v: string): string | null {
  const t = v.trim().toLowerCase()
  if (t.startsWith('https://')) return v.trim()
  if (t.startsWith('data:image/')) return v.trim()
  return null
}

export interface SanitizeResult {
  html: string
  /** 消毒后没有可见内容。调用方必须退回 generic 渲染 text —— 绝不白屏 */
  empty: boolean
  /** 剥了什么。属性记为 `@name`。不说出来的话模型不知道自己哪写错了 */
  stripped: string[]
}

export function sanitize(input: string): SanitizeResult {
  const src = String(input ?? '')
  const out: string[] = []
  const stripped = new Set<string>()
  /** 开着的白名单标签，用于补闭合 */
  const open: string[] = []
  /** >0 时正在丢弃一段带内容的危险标签 */
  let dropping = 0
  let dropTag = ''
  let text = ''          // 累计的可见文字，用来判空
  let i = 0

  const push = (s: string) => { if (!dropping) out.push(s) }

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) { const t = src.slice(i); if (!dropping) { text += t; push(esc(t)) } break }
    if (lt > i) { const t = src.slice(i, lt); if (!dropping) { text += t; push(esc(t)) } }

    // 注释 / DOCTYPE / 处理指令：整段丢。注释里能藏条件注释脚本
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? src.length : end + 3
      continue
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? src.length : end + 1
      continue
    }

    const gt = src.indexOf('>', lt)
    if (gt < 0) { i = src.length; break }   // 没闭合的 `<`：整段丢，不猜
    const raw = src.slice(lt + 1, gt)
    i = gt + 1

    const closing = raw.startsWith('/')
    const body = closing ? raw.slice(1) : raw
    const selfClose = body.trimEnd().endsWith('/')
    const nameEnd = body.search(/[\s/>]/)
    const tag = (nameEnd < 0 ? body : body.slice(0, nameEnd)).toLowerCase().trim()
    if (!tag) continue

    // ── 带内容一起丢的危险标签 ──
    if (DROP_WITH_CONTENT.has(tag)) {
      stripped.add(tag)
      if (closing) { if (dropTag === tag && dropping > 0) { dropping--; if (!dropping) dropTag = '' } }
      else if (!selfClose && !VOID.has(tag)) { if (!dropping) dropTag = tag; if (dropTag === tag) dropping++ }
      continue
    }
    if (dropping) continue   // 丢弃段落内部的一切照单全丢

    if (closing) {
      if (!ALLOW.has(tag)) { stripped.add(tag); continue }
      // 只闭合真正开着的那个，多余的闭合标签直接吃掉。
      // 中间没闭合的（<div><b>甲</div>）顺手补上，不让它把后面的内容吞进去
      const at = open.lastIndexOf(tag)
      if (at < 0) continue
      while (open.length > at) { const t = open.pop()!; push(`</${CASE[t] ?? t}>`) }
      continue
    }

    if (!ALLOW.has(tag)) { stripped.add(tag); continue }   // 丢标签，留文字

    // ── 属性 ──
    const attrs: string[] = []
    const rest = nameEnd < 0 ? '' : body.slice(nameEnd)
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(rest))) {
      const an = m[1].toLowerCase()
      let av = (m[2] ?? '').replace(/^["']|["']$/g, '')
      // on* 和任何带命名空间的（xlink:href）一律剥离，不看值
      if (an.startsWith('on') || an.includes(':') || an === 'href') { stripped.add('@' + an); continue }
      if (!ATTR.has(an)) { stripped.add('@' + an); continue }
      if (an === 'style') {
        const cleaned = cleanStyle(av)
        if (cleaned !== av) stripped.add('@style')
        if (!cleaned) continue
        av = cleaned
      }
      if (an === 'src') {
        const ok = cleanSrc(av)
        if (!ok) { stripped.add('@src'); continue }
        av = ok
      }
      attrs.push(`${CASE[an] ?? an}="${esc(av).replace(/"/g, '&quot;')}"`)
    }

    const name = CASE[tag] ?? tag
    if (VOID.has(tag) || selfClose) push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}/>`)
    else { push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>`); open.push(tag) }
  }

  // 补上没闭合的
  while (open.length) { const t = open.pop()!; out.push(`</${CASE[t] ?? t}>`) }

  const html = out.join('')
  // 空壳子（<div><span></span></div>）也算空 —— 它渲染出来就是一张白卡。
  // 判据：没有可见文字，也没有会自己占地方的图形元素
  const hasVisual = /<(img|svg|path|circle|rect|line|polyline|polygon|ellipse|hr)\b/i.test(html)
  return { html, empty: !text.trim() && !hasVisual, stripped: [...stripped] }
}
