/**
 * 卡片正文渲染 —— 纯函数，返回 HTML 字符串。
 *
 * 从 main.ts 抽出来是为了能测：车机屏那边是 DOM 操作跑不了单测，
 * 但"给定数据画出什么"这件事必须可测，否则像诊断 8 那种
 * "模板声明了 items 却静默不画"的 bug 只能靠肉眼发现。
 */
import { dayLabel } from './turn'
import { navForm, capForm, weatherForm } from './layout'

export const esc = (s: any) =>
  String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

export interface CardView {
  /** 需要高亮的项（车控卡刚被改动的那几扇窗）。由 main.ts 在渲染前塞进 data.hot —— 
   *  渲染层不该知道"谁刚被碰过"，那是交互状态不是数据 */
  template: string
  size: string
  title?: string
  data?: any
  [k: string]: any
}

export interface ListOpts {
  /** 最多显示几条。超出部分截断——屏幕 cursor:none，overflow:auto 等于永远看不到 */
  maxItems?: number
  /** more 截断并报剩余 · count 只报总数 · none 不限 */
  overflow?: 'more' | 'count' | 'none'
  /** 内容分几列 */
  cols?: number
}

/**
 * 列表正文。截断是硬需求不是优化：
 * 屏幕不可交互，滚动条等于摆设，第 N 条之后用户永远不知道存在。
 */
export function listBody(items: any[], opts: ListOpts = {}): string {
  const all = items ?? []
  const max = opts.maxItems ?? all.length
  if (opts.overflow === 'count' || max <= 0)
    return `<div class="lstcount"><b>${all.length}</b><span>项</span></div>`

  const shown = all.slice(0, max)
  const rest = all.length - shown.length
  return `<ol class="listcard${opts.cols === 2 ? ' c2' : ''}">${shown.map((i: any) => `
    <li><b>${esc(i.label ?? i)}</b>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}${
      i.right ? `<em class="rr">${esc(i.right)}</em>` : ''}</li>`).join('')}</ol>${
    rest > 0 ? `<div class="more">还有 ${rest} 条没显示</div>` : ''}`
}

export function cardBody(c: CardView): string {
  const d = c.data ?? {}
  switch (c.template) {
    case 'vehicle':
      // 车身图形留在 main.ts（它是资源不是逻辑），这里只留占位
      return `<div class="vehslot"></div>`
    case 'control':
      // 包一层容器：卡片本身是 flex column，靠 inline-block 排不成多列
      return `<div class="wins">` + (d.items ?? []).map((it: any) => {
        const isPct = typeof it.value === 'number' && it.unit === '%'
        const shown = typeof it.value === 'boolean' ? (it.value ? '开' : '关')
          : typeof it.value === 'number' ? `${Math.round(it.value)}${esc(it.unit ?? '')}`
          : esc(String(it.value ?? '--'))
        return `
        <div class="win${(d.hot ?? []).includes(it.key) ? ' hot' : ''}">
          <div class="top"><span>${esc(it.label)}</span><em>${shown}</em></div>
          ${isPct ? `<div class="track"><div class="fill" style="width:${Math.round(it.value)}%"></div></div>` : ''}
        </div>`
      }).join('') + `</div>`
    case 'confirm':
      // 跟列表卡同一条道理：用户是用语音选的（"第二个"），屏上必须能对上号。
      // 只有"确认/取消"两个字时不编号——那种问句是"要不要"，不是"选第几个"
      return `<div class="sub">${esc(d.question ?? d.text)}</div>` + (
        d.options?.length
          ? `<ol class="listcard opts">${d.options.map((o: string) => `<li><b>${esc(o)}</b></li>`).join('')}</ol>`
          : `<div>${['确认', '取消'].map(o => `<span class="opt">${o}</span>`).join('')}</div>`)
    case 'notice':
      return `<div class="sub">${esc(d.text)}</div>${d.suggestion ? `<div class="sug">${esc(d.suggestion)}</div>` : ''}`
    case 'list':
      // 序号是刚需：用户是用语音选的（"第二个"），屏上必须能对上号。
      // maxItems 由形态函数按档位给，这里只负责画
      return listBody(d.items, { maxItems: d.maxItems, overflow: d.overflow, cols: d.cols })
    case 'capability': {
      const items = d.items ?? []
      const form = capForm(c.size)
      // 33 项塞进一格是不可能的，老实报个数
      if (form.mode === 'count')
        return `<div class="capcount"><b>${items.length}</b><span>项能力</span></div>`
      return `<div class="cap ${form.mode}">${items.map((i: any) =>
        `<div class="${i.off ? 'off' : ''}">${esc(i.label)}<small>${esc(i.desc ?? '')}</small></div>`).join('')}</div>`
    }
    case 'weather': {
      const w = weatherForm(c.size)
      // 风力和湿度任一缺失都不该留下孤零零一个分隔点
      const sub = d.now
        ? [d.now.wind, d.now.humidity !== undefined ? `湿度${d.now.humidity}%` : ''].filter(Boolean).join(' · ')
        : ''
      const cast = (d.forecast ?? []).slice(0, w.forecast)
      return `${d.now ? `<div class="wxnow">
          <b>${Math.round(d.now.temperature)}<i>°</i></b>
          <div class="wxmeta"><span>${esc(d.now.weather)}</span><small>${esc(sub)}</small></div>
        </div>` : ''}
        ${cast.length ? `<div class="wxcast${w.forecastRow ? ' row' : ''}">${cast.map((f: any) => `
          <div><span>${esc(dayLabel(f.date))}</span><em>${esc(f.dayWeather)}</em><b>${Math.round(f.dayTemp)}°/${Math.round(f.nightTemp)}°</b></div>`).join('')}</div>` : ''}`
    }
    case 'nav':
      // 导航卡由 renderNavCard 单独处理——活地图有状态，不能跟着文字一起重绘
      return ''
    default: {
      // 诊断 8：模板声明了 items/actions 却只画 text，静默丢数据。
      // 不修的话模型会因为 generic 不好用而滥用生成式卡
      const parts: string[] = []
      if (d.text) parts.push(`<div class="sub">${esc(d.text)}</div>`)
      if (d.items?.length)
        parts.push(`<div class="glist">${d.items.map((i: any) => `
          <div class="gi"><span>${esc(i.label ?? i)}</span>${
            i.value !== undefined ? `<b>${esc(i.value)}${i.unit ? `<i>${esc(i.unit)}</i>` : ''}</b>` : ''}</div>`).join('')}</div>`)
      if (d.actions?.length)
        parts.push(`<div class="gacts">${d.actions.map((a: any, n: number) =>
          `<span class="opt">${n + 1} ${esc(a)}</span>`).join('')}</div>`)
      return parts.join('') || `<div class="sub"></div>`
    }
  }
}
