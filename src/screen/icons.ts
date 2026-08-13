/**
 * 图标资产 —— 内联 SVG 字符串（数据不是逻辑，同 CAR_SVG 的待遇）。
 *
 * 为什么不用 emoji：跨系统渲染不一致、颜色不受控（§10 的既定决策）。
 * 全部 stroke:currentColor 线性风格，颜色跟语义色 --ac 走。
 */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

/** 模板 → 身份图标。40px 图标块是"远看一眼定位卡片类型"的锚点 */
export const TPL_ICONS: Record<string, string> = {
  nav: svg('<path d="M3 11l18-8-8 18-2.5-7.5L3 11z"/>'),
  weather: svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/>'),
  control: svg('<rect x="3.5" y="9" width="17" height="8" rx="2.5"/><path d="M6.5 9V7.5A2.5 2.5 0 0 1 9 5h6a2.5 2.5 0 0 1 2.5 2.5V9M7.5 13h.01M12 13h.01M16.5 13h.01"/>'),
  vehicle: svg('<path d="M5 12l1.6-4.2A2 2 0 0 1 8.5 6.5h7a2 2 0 0 1 1.9 1.3L19 12M4.5 12h15a1.5 1.5 0 0 1 1.5 1.5V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2.5A1.5 1.5 0 0 1 4.5 12zM7 17v1.5M17 17v1.5"/>'),
  media: svg('<path d="M9 18.5V6l10-2v12.2"/><circle cx="6.8" cy="18.5" r="2.4"/><circle cx="16.8" cy="16.2" r="2.4"/>'),
  list: svg('<path d="M8.5 6h11M8.5 12h11M8.5 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  confirm: svg('<circle cx="12" cy="12" r="9"/><path d="M9 12.5l2.2 2.2L15.5 10"/>'),
  feedback: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.4 2.4 4.8-5.3"/>'),
  notice: svg('<path d="M12 4a5.5 5.5 0 0 1 5.5 5.5c0 4 1.5 5.2 1.5 5.2H5s1.5-1.2 1.5-5.2A5.5 5.5 0 0 1 12 4zM10.2 18.5a2 2 0 0 0 3.6 0"/>'),
  capability: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8h.01"/>'),
  generic: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6"/>'),
  canvas: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>'),
  'canvas-app': svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>'),
}

/* 播放器控制键（不用 ⏮⏯⏭ emoji） */
export const ICON_PREV = svg('<path d="M6 5v14M20 5l-11 7 11 7V5z"/>')
export const ICON_PLAY = svg('<path d="M7 4.5l13 7.5-13 7.5v-15z"/>')
export const ICON_NEXT = svg('<path d="M18 5v14M4 5l11 7-11 7V5z"/>')

/**
 * 天气现象 → 图标。按关键词匹配**数据值**（同 CN 枚举表的待遇，
 * 是展示映射不是意图分支）。
 */
const W = {
  sun: svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/>'),
  cloudSun: svg('<path d="M5 6.8l1.2 1.2M10.5 3.5v1.7M15.2 6.2A3.4 3.4 0 0 0 9 7.6"/><path d="M7 19h9.5a3.5 3.5 0 0 0 .6-6.95 5 5 0 0 0-9.7 1.2A3 3 0 0 0 7 19z"/>'),
  cloud: svg('<path d="M6.5 19h10.8a3.7 3.7 0 0 0 .6-7.35 5.3 5.3 0 0 0-10.3 1.25A3.2 3.2 0 0 0 6.5 19z"/>'),
  rain: svg('<path d="M6.5 15h10.8a3.7 3.7 0 0 0 .6-7.35A5.3 5.3 0 0 0 7.6 8.9 3.2 3.2 0 0 0 6.5 15z"/><path d="M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5"/>'),
  storm: svg('<path d="M6.5 14h10.8a3.7 3.7 0 0 0 .6-7.35A5.3 5.3 0 0 0 7.6 7.9 3.2 3.2 0 0 0 6.5 14z"/><path d="M12.5 14l-2.5 4h3l-2 4"/>'),
  snow: svg('<path d="M6.5 15h10.8a3.7 3.7 0 0 0 .6-7.35A5.3 5.3 0 0 0 7.6 8.9 3.2 3.2 0 0 0 6.5 15z"/><path d="M8.5 18.5h.01M12 20h.01M15.5 18.5h.01"/>'),
  fog: svg('<path d="M4 15h16M6 18.5h12M5 11.5h14"/>'),
}

export function weatherIcon(condition: string | undefined): string {
  const c = condition ?? ''
  if (/雷/.test(c)) return W.storm
  if (/雪/.test(c)) return W.snow
  if (/雨/.test(c)) return W.rain
  if (/雾|霾/.test(c)) return W.fog
  if (/多云|局部/.test(c)) return W.cloudSun
  if (/阴|云/.test(c)) return W.cloud
  return W.sun
}
