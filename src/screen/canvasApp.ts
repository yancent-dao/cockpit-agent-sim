/**
 * canvas-app 的沙箱构造 —— 全系统**唯一的容器**（公理 1 的逃生舱）。
 *
 * 模型的 JS 在这里真的会执行。隔离靠 iframe 的**源隔离**而不是消毒：
 * sandbox="allow-scripts"（无 allow-same-origin）下，iframe 是 opaque origin，
 * 拿不到宿主的 localStorage（OpenRouter/高德 Key 就在里面）、碰不到 bus、
 * 够不着桌面 DOM。消毒器管静态 canvas，这里的边界是隔离。
 *
 * 纯字符串构造，不碰 DOM —— 安全属性必须可测（铁律写在测试里，不是注释里的善意）。
 */
import { tokensFor } from '../design/tokens'

/**
 * 铁律 ①：只有 allow-scripts。
 * 加 allow-same-origin 等于没开沙箱——模型代码直接读走 Key。
 * 这个常量有测试锁死字符串内容，改它先想清楚。
 */
export const SANDBOX = 'allow-scripts'

/**
 * 铁律 ②：CSP 禁掉一切外呼（default-src 'none'）。
 * 模型代码能 fetch 任意 URL 的话，它就是一个不受控的信标。
 * 内联样式/脚本放行（不然它什么都画不了），data: 图片放行（不产生网络请求）。
 */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"

/**
 * 桥的沙箱侧：自动上报内容高度（动态尺寸的输入），
 * 暴露 cockpit.action(value) 给模型代码上报用户交互。
 * 宿主侧对每条消息做形状校验（validateBridgeMsg）——桥上的一切都是不可信数据。
 */
const BRIDGE = `<script>
(function(){
  var post = function(m){ parent.postMessage(m, '*') }
  window.cockpit = { action: function(v){ post({ type: 'action', value: String(v).slice(0, 200) }) } }
  var report = function(){ post({ type: 'height', px: document.documentElement.scrollHeight }) }
  addEventListener('load', report)
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(report).observe(document.documentElement)
})()
</script>`

/**
 * 组装 srcdoc。模型的 html **原样**进来——沙箱内不消毒，隔离才是这里的边界；
 * token 注入让它默认长得像这套系统（跟静态 canvas 的 Shadow DOM 同一待遇）。
 */
export function buildSrcdoc(html: string): string {
  return `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${tokensFor('screen')}
html,body{margin:0;background:transparent;color:var(--tx-1);font-family:"PingFang SC","Noto Sans CJK SC",sans-serif;font-size:var(--t-cap)}
*{box-sizing:border-box;max-width:100%}</style>
${BRIDGE}
</head><body>${html}</body></html>`
}

export type BridgeMsg = { type: 'height'; px: number } | { type: 'action'; value: string }

/** 桥消息形状校验。只认两个形状，其余一律拒收——模型代码能 post 任意东西 */
export function validateBridgeMsg(raw: unknown): BridgeMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as any
  if (m.type === 'height' && typeof m.px === 'number' && Number.isFinite(m.px) && m.px > 0)
    return { type: 'height', px: m.px }
  if (m.type === 'action' && typeof m.value === 'string' && m.value.length <= 200)
    return { type: 'action', value: m.value }
  return null
}
