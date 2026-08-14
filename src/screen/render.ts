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
import { weatherIcon } from './icons'

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
    <li data-act="tap:item" data-value="${esc(i.value ?? `第${n + 1}个：${i.label ?? i}`)}"><b>${esc(i.label ?? i)}</b>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}${
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
  media: 'media', list: 'pick', confirm: 'pick', stagedlist: 'pick',
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
    const pct = typeof it.pct === 'number' ? it.pct
      : (typeof raw === 'number' && it.unit === '%' ? raw : undefined)
    /**
     * 按**值类型**分级（展示映射，同 CN 枚举表待遇）：
     *   布尔  → 状态胶囊。"开"渲染成大黑字占一整块是空调卡实拍抓到的丑
     *   文本  → 降一级排版（txtv），"吹面+吹脚"不跟温度抢主角
     *   数值  → 大数字照旧
     */
    const body = typeof raw === 'boolean'
      ? `<div class="pillv${raw ? ' on' : ''}">${raw ? '已开启' : '已关闭'}</div>`
      : typeof raw === 'number'
        ? `<div class="num">${Math.round(raw)}${it.unit ? `<i>${esc(it.unit)}</i>` : ''}</div>`
        : `<div class="txtv">${esc(raw ?? '--')}</div>`
    return `<div class="blk${it.hot ? ' hot' : ''}">
      <div class="lb">${esc(it.label)}</div>
      ${body}
      ${pct !== undefined
        ? `<div class="trk"><div class="fl" style="width:${Math.max(0, Math.min(100, Math.round(pct)))}%"></div>${
            typeof it.target === 'number'
              ? `<div class="tg" style="left:${Math.max(0, Math.min(100, Math.round(it.target)))}%"></div>` : ''}</div>`
        : ''}
    </div>`
  }).join('')}</div>`
}

/**
 * 导航卡与播放器卡是**固定骨架 + 按 form 显隐**（活地图和视频元素有状态，
 * 不能跟着文字一起重绘）。骨架和"哪个块对应哪个元素"放这里，
 * 是为了让**「形态函数声明过的块，渲染层必须有地方画」**成为一条可测的不变量。
 *
 * 这条不变量正是车身图死掉的那种缺口的解药：它要求高度 ≥4 行而档位最高 2 行，
 * 图画好了从没在屏幕上出现过 —— 声明和实现之间没人对账。
 */
export const NAV_SKELETON = `<div class="navwrap">
  <div class="navdesthead"></div>
  <div class="turnbar"></div>
  <div class="lanebar"></div>
  <div class="mapbox"></div>
  <div class="navthen"></div>
  <div class="navfoot"></div>
</div>`
export const NAV_SLOTS: Record<string, string> = {
  dest: '.navdesthead', turn: '.turnbar', lane: '.lanebar',
  map: '.mapbox', then: '.navthen', eta: '.navfoot',
}

export const PLAYER_SKELETON = `<div class="plwrap">
  <div class="plart"></div>
  <div class="plmeta"><b class="pltrack"></b><span class="plartist"></span>
    <div class="plbar"><div class="pltrk"><div class="plfl"></div></div>
      <span class="pltime"></span></div>
    <div class="plmix"></div>
    <div class="plvol"></div>
    <div class="pl-next"></div>
    <div class="plctl"></div>
    <div class="pl-hint"></div>
    <div class="plqueue"></div></div>
</div>`
export const PLAYER_SLOTS: Record<string, string> = {
  art: '.plart', title: '.pltrack', sub: '.plartist', bar: '.plbar',
  mix: '.plmix', vol: '.plvol', next: '.pl-next', toggle: '.plctl',
  hint: '.pl-hint', queue: '.plqueue',
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
      const shown = (d.items ?? []).slice(0, form.maxItems)
      // 1/6 卡是 4×2 的比例，4 块单列堆叠每块都被压扁——4 块起在单栏形态下升 2 栏。
      // 只动排布不动 maxItems，跟 summary 的可见条数不冲突
      const cols = shown.length >= 4 && (form.cols ?? 1) === 1 ? 2 : form.cols
      return blocksBody(shown.map((it: any) => ({ ...it, hot: hot.includes(it.key) })), { cols })
    }
    case 'confirm': {
      /**
       * **按档位分块**（2026-08-14）。以前这个分支压根不读 form，三档在屏幕上
       * 长得一模一样：用户点放大，卡变大了内容没变。
       * `why`（为什么要问你）是解释性内容，只有宽档才给。
       */
      const cf = formOf('confirm', ...dimsOf(c.size))
      const why = cf.blocks.includes('why') && d.why
        ? `<div class="why">${esc(d.why)}</div>` : ''
      // 跟列表卡同一条道理：用户是用语音选的（"第二个"），屏上必须能对上号。
      // 只有"确认/取消"两个字时不编号——那种问句是"要不要"，不是"选第几个"
      return `<div class="sub">${esc(d.question ?? d.text)}</div>${why}` + (
        d.options?.length
          ? `<ol class="listcard opts">${d.options.map((o: string, n: number) =>
              `<li data-act="tap:item" data-value="${esc(`第${n + 1}个：${o}`)}"><b>${esc(o)}</b></li>`).join('')}</ol>`
          : `<div>${['确认', '取消'].map(o => `<span class="opt">${o}</span>`).join('')}</div>`)
    }
    case 'notice': {
      /**
       * `suggestion` 是**恒在块** ——「拒绝必须携带机器可读原因」是项目核心原则，
       * 只说"不行"不说"怎么办"等于原则没落地。大档才多出"为什么"这层解释。
       */
      const nf = formOf('notice', ...dimsOf(c.size))
      const why = nf.blocks.includes('why') && d.why ? `<div class="why">${esc(d.why)}</div>` : ''
      return `<div class="sub">${esc(d.text)}</div>${why}${
        d.suggestion ? `<div class="sug">${esc(d.suggestion)}</div>` : ''}`
    }
    case 'feedback': {
      /**
       * 两档：chip 只有结论（「已开窗」），box 多一句说明。
       * 以前它落到 default 分支、用的是 `formOf('generic')` —— 自己声明的形态从未生效。
       */
      const ff = formOf('feedback', ...dimsOf(c.size))
      const detail = ff.blocks.includes('detail') && (d.detail ?? d.sub)
        ? `<div class="sug">${esc(d.detail ?? d.sub)}</div>` : ''
      return `<div class="sub">${esc(d.text ?? d.title ?? '')}</div>${detail}`
    }
    case 'list':
      // 序号是刚需：用户是用语音选的（"第二个"），屏上必须能对上号。
      // maxItems 由形态函数按档位给，这里只负责画
      // 放几条由卡片**自己的档位**算，不信 data 里带的数字——
      // 卡被仲裁改小了 data 不会跟着变，那样就会画出放不下的东西
      return listBody(d.items, formOf('list', ...dimsOf(c.size)))
    case 'stagedlist':
      // 台下清单长得就是列表，只是条目 value 带卡 id（点击直调召回）
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
        `<div class="${i.off ? 'off' : ''}">${i.icon ? `<span class="cico">${esc(i.icon)}</span>` : ''}${esc(i.label)}<small>${esc(i.desc ?? '')}</small></div>`).join('')}</div>${
        rest > 0 ? `<div class="more">还有 ${rest} 项，问我"你还会什么"就行</div>` : ''}`
    }
    /**
     * 绘本卡（「路上的故事」）。同一张卡按 story.phase 换版式：
     * 定妆时并排显示原照片与生成的主角（家长要判断"像不像"，不并排没法判断），
     * 讲述时画面铺满、一句话压底。
     *
     * 进度点**不显示总数** —— 故事是开放的（孩子说结束才结束），
     * 标了总数等于告诉孩子"还有三页就没了"，他会开始倒计时而不是听故事。
     * 虚线圈是还在画的页：一边讲一边长这件事必须让人看见。
     */
    case 'storybook': {
      const form = formOf('storybook', ...dimsOf(c.size))
      const has = (b: string) => form.blocks.includes(b)
      // 定妆阶段：左小图是家长给的照片，右大图是生成的主角
      if (d.photo) return `<div class="sbcast">
        <div class="sbsrc"><span>你给我的照片</span><img src="${esc(d.photo)}" alt=""></div>
        <div class="sbout">${d.image ? `<img src="${esc(d.image)}" alt="">` : '<div class="sbwait"></div>'}
          <p>${esc(d.line)}</p></div></div>`
      const dots = Array.from({ length: Number(d.total) || 0 }, (_, i) =>
        `<i class="${i + 1 === Number(d.page) ? 'on' : ''}"></i>`).join('')
        + Array.from({ length: Number(d.pending) || 0 }, () => '<i class="pend"></i>').join('')
      return `<div class="sb">
        <div class="sbart">${d.image ? `<img src="${esc(d.image)}" alt="">` : ''}</div>
        <div class="sbcap">
          ${has('chapter') && d.chapter ? `<div class="sbch">${esc(d.title)} · 第 ${esc(d.chapter)} 章</div>` : ''}
          <p class="sbline">${esc(d.line)}</p>
          ${has('lesson') && d.ideas?.length ? `<div class="sbidea">${esc(d.ideas.join(' · '))}</div>` : ''}
          <div class="sbfoot">
            <div class="sbdots">${dots}</div>
            ${has('ctl') ? `<div class="sbctl"><span data-act="tap:prev">‹</span>
              <span data-act="tap:toggle">⏸</span><span data-act="tap:next">›</span></div>` : ''}
          </div>
        </div></div>`
    }
    /* ══════════ 2026-08-14 新增六张 ══════════ */
    /** 轮播：带图的横向条目流。页码是屏内状态，这里只画当前这一页 */
    case 'carousel': {
      const f = formOf('carousel', ...dimsOf(c.size))
      const all = d.items ?? []
      const page = Number(d.page) || 0
      const per = f.maxItems ?? 3
      const shown = all.slice(page * per, page * per + per)
      const pages = Math.max(1, Math.ceil(all.length / per))
      return `<div class="cw" style="grid-template-columns:repeat(${per},1fr)">${shown.map((i: any) => `
        <div class="ci" data-act="tap:item" data-value="${esc(i.label)}">
          <div class="cim"${i.image ? ` style="background-image:url('${esc(i.image)}')"` : ''}></div>
          <span>${esc(i.label)}</span>${
            f.blocks.includes('sub') && i.sub ? `<small>${esc(i.sub)}</small>` : ''}
        </div>`).join('')}</div>${pages > 1
        ? `<div class="cpage"><b data-act="tap:prev">‹</b>${page + 1} / ${pages}<b data-act="tap:next">›</b></div>` : ''}`
    }
    /** 对比：横向并列。best 那一项加重，一眼看出哪个更好 */
    case 'compare': {
      const f = formOf('compare', ...dimsOf(c.size))
      const cols = (d.columns ?? []).slice(0, f.maxItems)
      return `<div class="cmpw" style="grid-template-columns:repeat(${cols.length || 1},1fr)">${
        cols.map((col: any) => `<div class="cmpc">
          <div class="cmph"><b>${esc(col.label)}</b>${
            f.blocks.includes('badge') && col.badge ? `<span class="opt">${esc(col.badge)}</span>` : ''}</div>
          ${(col.rows ?? []).map((r: any) =>
            `<div class="gi"><span>${esc(r.k)}</span><b${r.best ? ' class="best"' : ''}>${esc(r.v)}</b></div>`).join('')}
        </div>`).join('')}</div>`
    }
    /**
     * 进展：**状态点是命根子** —— 后台任务以前借用列表卡，
     * 一条「正在查」和一条「已完成」长得完全一样，用户看不出哪件事还在跑。
     */
    case 'progress': {
      const f = formOf('progress', ...dimsOf(c.size))
      const { shown, rest } = truncate(d.items ?? [], f.maxItems)
      return `<div class="pgw">${shown.map((i: any) => `
        <div class="pgi">
          <div class="pgh"><i class="st-${esc(i.state ?? 'running')}"></i>
            <span>${esc(i.label)}</span></div>
          ${f.blocks.includes('detail') && i.detail ? `<small>${esc(i.detail)}</small>` : ''}
          ${f.blocks.includes('bar') && i.percent !== undefined
            ? `<div class="pltrk"><div class="plfl" style="width:${Math.max(0, Math.min(100, Number(i.percent)))}%"></div></div>` : ''}
        </div>`).join('')}${rest ? `<div class="more">还有 ${rest} 件</div>` : ''}</div>`
    }
    /** 指标：一个大数字。它是 chip / tile 两个小档真正的主人 */
    case 'metric': {
      const f = formOf('metric', ...dimsOf(c.size))
      return `<div class="mtw">
        <div class="mtv"><b>${esc(d.value)}</b>${d.unit ? `<i>${esc(d.unit)}</i>` : ''}${
          f.blocks.includes('trend') && d.trend ? `<em class="mttr">${esc(d.trend)}</em>` : ''}</div>
        ${f.blocks.includes('sub') && d.sub ? `<small>${esc(d.sub)}</small>` : ''}
        ${f.blocks.includes('bar') && d.percent !== undefined
          ? `<div class="pltrk"><div class="plfl" style="width:${Math.max(0, Math.min(100, Number(d.percent)))}%"></div></div>` : ''}
      </div>`
    }
    /** 图表：SVG 柱状，纯函数可测 —— 生成式卡的**可预测替代** */
    case 'chart': {
      const f = formOf('chart', ...dimsOf(c.size))
      const series = (d.series ?? []).slice(0, f.maxItems)
      const max = Math.max(1, ...series.map((x: any) => Number(x.value) || 0))
      return `<div class="chw">${series.map((x: any) => {
        const h = Math.max(4, Math.round((Number(x.value) || 0) / max * 100))
        return `<i style="height:${h}%" title="${esc(x.label)}"></i>`
      }).join('')}</div>${f.blocks.includes('axis') ? `<div class="chax">
        <span>${esc(series[0]?.label ?? '')}</span>${
          f.blocks.includes('legend') && d.unit ? `<span>${esc(d.unit)}</span>` : ''}
        <span>${esc(series[series.length - 1]?.label ?? '')}</span></div>` : ''}`
    }
    /** 图片：新档 frame（最接近正方）的主要用户。缺图时不留白卡 */
    case 'image': {
      const f = formOf('image', ...dimsOf(c.size))
      return `<div class="imw"${d.url ? ` style="background-image:url('${esc(d.url)}')"` : ''}></div>${
        f.blocks.includes('caption') && d.caption ? `<div class="sub">${esc(d.caption)}</div>` : ''}${
        f.blocks.includes('meta') && d.meta ? `<small class="imeta">${esc(d.meta)}</small>` : ''}`
    }
    case 'weather': {
      const w = weatherForm(...dimsOf(c.size))
      // 风力和湿度任一缺失都不该留下孤零零一个分隔点
      const sub = d.now
        ? [d.now.wind, d.now.humidity !== undefined ? `湿度${d.now.humidity}%` : ''].filter(Boolean).join(' · ')
        : ''
      const cast = (d.forecast ?? []).slice(0, w.days ?? 0)
      /**
       * 今日最高/最低是最基本的一项，之前连大档都没有（2026-08-14 调研）。
       * 恒在块，任何档位都给。
       */
      const rng = d.range
        ? `<small class="wxrng">${Math.round(d.range.high)}° / ${Math.round(d.range.low)}°</small>` : ''
      /**
       * 逐时降水条 —— **车里天气卡的主角**。通行判据是「一秒读懂：当前温度、
       * 下一次降水、今日温差、预警状态」；5 天预报是手机首页的逻辑。
       * 柱高表示气温，蓝色表示这个钟点会下雨。
       */
      const hrs = (d.hourly ?? []).slice(0, w.hours ?? 0)
      const hourly = hrs.length ? `<div class="hourly">${hrs.map((h: any) => {
        const wet = Number(h.pop) >= 40
        return `<i style="height:${Math.max(18, Math.min(100, Number(h.temp) * 2.6))}%"${
          wet ? ' class="wet"' : ''}></i>`
      }).join('')}</div>` : ''
      return `${d.now ? `<div class="wxnow">
          <b>${Math.round(d.now.temperature)}<i>°</i></b>
          <div class="wxmeta"><span>${esc(d.now.weather)}</span>${rng}<small>${esc(sub)}</small></div>
          <span class="wxico">${weatherIcon(d.now.weather)}</span>
        </div>` : ''}${hourly}${cast.length
        // 预报也是并列数据，走块状均分——省掉一套只给天气用的 CSS
        ? `<div class="fc">${blocksBody(cast.map((f: any) => ({
            label: dayLabel(f.date),
            value: `${Math.round(f.dayTemp)}°/${Math.round(f.nightTemp)}°`,
          })), { cols: w.days ?? 1 })}</div>`
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
