/**
 * 卡片正文渲染 —— 纯函数，返回 HTML 字符串。
 *
 * 从 main.ts 抽出来是为了能测：车机屏那边是 DOM 操作跑不了单测，
 * 但"给定数据画出什么"这件事必须可测，否则像诊断 8 那种
 * "模板声明了 items 却静默不画"的 bug 只能靠肉眼发现。
 */
import { dayLabel } from './turn'
import { capForm, weatherForm, formOf } from '../config/forms'
import { dimsOf, normalizeTier } from '../config/grid'

import { esc } from '../text'
export { esc }

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
  /** 最多显示几条。截断保留（模型世界观以 summary 为准），触控后卡内另可滚动 */
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
/** 截断的唯一公式。listBody / capability / generic 都消费它——三份 slice+rest 归一 */
export function truncate<T>(items: T[], max?: number): { shown: T[]; rest: number } {
  const all = items ?? []
  const m = max ?? all.length
  const shown = all.slice(0, m)
  return { shown, rest: all.length - shown.length }
}

export function listBody(items: any[], opts: ListOpts = {}): string {
  const all = items ?? []
  const max = opts.maxItems ?? all.length
  if (opts.overflow === 'count' || max <= 0)
    return `<div class="lstcount"><b>${all.length}</b><span>项</span></div>`

  const { shown, rest } = truncate(all, max)
  // data-act/-value：触控命中目标。点第 2 项 = 说"第二个"（回答类路由），
  // value 带序号和名字，模型收到的合成输入跟语音说法同构
  return `<ol class="listcard${opts.cols === 2 ? ' c2' : ''}">${shown.map((i: any, n: number) => `
    <li data-act="tap:item" data-value="${esc(`第${n + 1}个：${i.label ?? i}`)}"><b>${esc(i.label ?? i)}</b>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}${
      i.right ? `<em class="rr">${esc(i.right)}</em>` : ''}</li>`).join('')}</ol>${
    rest > 0 ? `<div class="more">还有 ${rest} 条没显示</div>` : ''}`
}


/**
 * 档位类。字号 = 字阶 × `--u`，一个类管住一整张卡的排版比例。
 * 之前是 22 条 `.sz-*` 硬怼 60 处 font-size —— 加一个档位要补 6 条规则。
 */
export const tierClass = (size: string) => `t-${normalizeTier(size)}`

/**
 * 八类语义色映射。
 *
 * 诊断 5：系统卡描边、提示底色、拒绝横幅全是 warning 橙，用户分不出三者。
 * 身份由**模板 + 紧急度**定，不由 kind 定 —— kind 是编排优先级
 * （谁先占位、谁被挤），跟"这张卡长什么样"是两码事。
 *
 * 紧急度是**正交**维度：同一张车控卡平时是 info，胎压报警时是 danger。
 * 所以它盖过模板色而不是另开一套模板。
 */
const ACCENT: Record<string, string> = {
  nav: 'brand', weather: 'info', control: 'info', vehicle: 'info',
  media: 'media', list: 'pick', confirm: 'pick',
  feedback: 'ok', notice: 'warn', capability: 'sys', generic: 'sys', info: 'sys',
  canvas: 'media', 'canvas-app': 'media',   // 紫色——生成式跟固定模板要一眼分得出
}
const URGENCY: Record<string, string> = { critical: 'danger', warn: 'warn' }

export const accentClass = (template: string, d: any = {}) =>
  `a-${URGENCY[d?.urgency] ?? ACCENT[template] ?? 'sys'}`

export interface BlockOpts {
  /** 分几栏。落到 class 上（c2/c3），不写内联 style —— 那样 CSS 改不动 */
  cols?: number
}

/**
 * 块状均分。
 *
 * 诊断 1：卡片内容缩在左上角，下半张脸空着。根因是内容按自然高度从上往下堆，
 * 剩下的空间无人认领。12×4 之后卡片可能是 4×2 也可能是 8×4，"自然高度"这个
 * 概念本身就不成立 —— 必须让**内容去适应容器**。
 *
 * `grid-auto-rows:1fr` 让块平分剩余高度：三块就一人三分之一，四块就一人四分之一，
 * 数据条数变了高度自动重分，不用为每种条数写一条 CSS。
 */
export function blocksBody(items: any[], opts: BlockOpts = {}): string {
  const cls = opts.cols === 3 ? ' c3' : opts.cols === 2 ? ' c2' : ''
  return `<div class="blocks${cls}">${(items ?? []).map(it => {
    // 0 是有效值（车窗全关），不能被当成空
    const raw = it.value
    const shown = typeof raw === 'boolean' ? (raw ? '开' : '关')
      : typeof raw === 'number' ? String(Math.round(raw))
      : raw === undefined || raw === null ? '--' : String(raw)
    const pct = typeof it.pct === 'number' ? it.pct
      : (typeof raw === 'number' && it.unit === '%' ? raw : undefined)
    return `<div class="blk${it.hot ? ' hot' : ''}">
      <div class="lb">${esc(it.label)}</div>
      <div class="num">${esc(shown)}${it.unit ? `<i>${esc(it.unit)}</i>` : ''}</div>
      ${pct !== undefined
        ? `<div class="trk"><div class="fl" style="width:${Math.max(0, Math.min(100, Math.round(pct)))}%"></div>${
            typeof it.target === 'number'
              ? `<div class="tg" style="left:${Math.max(0, Math.min(100, Math.round(it.target)))}%"></div>` : ''}</div>`
        : ''}
    </div>`
  }).join('')}</div>`
}

export function cardBody(c: CardView): string {
  const d = c.data ?? {}
  switch (c.template) {
    case 'vehicle':
      // 车身图形留在 main.ts（它是资源不是逻辑），这里只留占位
      return `<div class="vehslot"></div>`
    case 'control': {
      // 四扇窗的开度是典型的"并列数据"，走块状均分
      const form = formOf('control', ...dimsOf(c.size))
      const hot = d.hot ?? []
      return blocksBody((d.items ?? []).slice(0, form.maxItems)
        .map((it: any) => ({ ...it, hot: hot.includes(it.key) })), { cols: form.cols })
    }
    case 'confirm':
      // 跟列表卡同一条道理：用户是用语音选的（"第二个"），屏上必须能对上号。
      // 只有"确认/取消"两个字时不编号——那种问句是"要不要"，不是"选第几个"
      return `<div class="sub">${esc(d.question ?? d.text)}</div>` + (
        d.options?.length
          ? `<ol class="listcard opts">${d.options.map((o: string, n: number) =>
              `<li data-act="tap:item" data-value="${esc(`第${n + 1}个：${o}`)}"><b>${esc(o)}</b></li>`).join('')}</ol>`
          : `<div>${['确认', '取消'].map(o => `<span class="opt">${o}</span>`).join('')}</div>`)
    case 'notice':
      return `<div class="sub">${esc(d.text)}</div>${d.suggestion ? `<div class="sug">${esc(d.suggestion)}</div>` : ''}`
    case 'list':
      // 序号是刚需：用户是用语音选的（"第二个"），屏上必须能对上号。
      // maxItems 由形态函数按档位给，这里只负责画
      // 放几条由卡片**自己的档位**算，不信 data 里带的数字——
      // 卡被仲裁改小了 data 不会跟着变，那样就会画出放不下的东西
      return listBody(d.items, formOf('list', ...dimsOf(c.size)))
    case 'capability': {
      const items = d.items ?? []
      const form = capForm(...dimsOf(c.size))
      // 33 项塞进一格是不可能的，老实报个数
      if (form.mode === 'count')
        return `<div class="capcount"><b>${items.length}</b><span>项能力</span></div>`
      // 屏幕不可滚动，放不下的必须截断并说明——切掉半行等于骗人
      const { shown, rest } = truncate(items, form.maxItems)
      return `<div class="cap ${form.mode} c${form.cols ?? 1}">${shown.map((i: any) =>
        `<div class="${i.off ? 'off' : ''}">${esc(i.label)}<small>${esc(i.desc ?? '')}</small></div>`).join('')}</div>${
        rest > 0 ? `<div class="more">还有 ${rest} 项，问我"你还会什么"就行</div>` : ''}`
    }
    case 'weather': {
      const w = weatherForm(...dimsOf(c.size))
      // 风力和湿度任一缺失都不该留下孤零零一个分隔点
      const sub = d.now
        ? [d.now.wind, d.now.humidity !== undefined ? `湿度${d.now.humidity}%` : ''].filter(Boolean).join(' · ')
        : ''
      const cast = (d.forecast ?? []).slice(0, w.maxItems ?? 0)
      return `${d.now ? `<div class="wxnow">
          <b>${Math.round(d.now.temperature)}<i>°</i></b>
          <div class="wxmeta"><span>${esc(d.now.weather)}</span><small>${esc(sub)}</small></div>
        </div>` : ''}${cast.length
        // 预报也是并列数据，走块状均分——省掉一套只给天气用的 CSS
        ? blocksBody(cast.map((f: any) => ({
            label: dayLabel(f.date),
            value: `${Math.round(f.dayTemp)}°/${Math.round(f.nightTemp)}°`,
          })), { cols: (w.cols ?? 1) > 1 ? 3 : 1 })
        : ''}`
    }
    case 'nav':
      // 导航卡由 renderNavCard 单独处理——活地图有状态，不能跟着文字一起重绘
      return ''
    default: {
      // 诊断 8：模板声明了 items/actions 却只画 text，静默丢数据。
      // 不修的话模型会因为 generic 不好用而滥用生成式卡
      const form = formOf('generic', ...dimsOf(c.size))
      const parts: string[] = []
      if (d.text) parts.push(`<div class="sub">${esc(d.text)}</div>`)
      if (d.items?.length)
        parts.push(`<div class="glist">${truncate(d.items, form.maxItems).shown.map((i: any) => `
          <div class="gi"><span>${esc(i.label ?? i)}</span>${
            i.value !== undefined ? `<b>${esc(i.value)}${i.unit ? `<i>${esc(i.unit)}</i>` : ''}</b>` : ''}</div>`).join('')}</div>`)
      if (d.actions?.length)
        parts.push(`<div class="gacts">${d.actions.map((a: any, n: number) =>
          `<span class="opt">${n + 1} ${esc(a)}</span>`).join('')}</div>`)
      return parts.join('') || `<div class="sub"></div>`
    }
  }
}

/**
 * 秒 → mm:ss（超过一小时进位到 h:mm:ss）。
 *
 * 播放进度**不进 store** —— position 每秒变好几次，进信号系统就是每秒重评一遍规则。
 * 它由车机屏本地的 `<audio>` 自己渲染，走展示层不走信号。
 * 这条守的是「状态 vs 遥测」的界线：store 存**在放什么、放不放**，
 * **放到第几秒**是遥测。
 */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--'
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 进度百分比。电台是直播流 duration=Infinity —— 画一条走到底的进度条是撒谎，返回 null */
export function progressPct(cur: number, dur: number): number | null {
  if (!Number.isFinite(dur) || dur <= 0) return null
  return Math.max(0, Math.min(100, Math.round((cur / dur) * 100)))
}
