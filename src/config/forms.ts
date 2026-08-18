import { listCapacity, capacityOf, contentCols, listCols } from './grid'
/**
 * 尺寸 → 形态。卡片尺寸放开之后，"支持某个尺寸"要落到"在那个尺寸下能看"。
 *
 * 这里只回答"显示哪些块、放几条、分几栏"，具体排版在 CSS 里。抽成纯函数是为了能测——
 * 车机屏那边是 DOM 操作，跑不了单测。
 *
 * ## 为什么签名是 `(cols, rows)` 而不是 `(size)`
 *
 * 形状从 4 个涨到 14 个之后，按名字查表要写 14 模板 × 14 形状 = 196 组，没法维护，
 * 而且加一个形状就要把 14 个表全补一遍——正好踩中"加能力 = 加代码"。
 * 改成按**几何阈值**判断：宽度只有 5 种取值（2/4/6/8/12）、高度 4 种（2/4/6/8），
 * 每个模板实际只关心 2–3 个阈值。以后加形状只改 `TIERS` 表，这个文件一行不动。
 *
 * ## 阈值都用面积（cols × rows）还是分开用
 *
 * 分情况，写在各函数里：
 *   · "放不放得下这块内容" → 看**面积**（一屏 96 单元，24 单元 ≈ 屏幕 1/4）
 *   · "排成几栏 / 横着排还是竖着排" → 只看**宽度**
 *   · "地图会不会被压成一条缝" → 宽高都要看
 *
 * ## 2026-08-14 栅格改 12×8 之后
 *
 * 行数翻倍，所以**所有用到 r 和 area 的阈值都跟着翻倍**。同时按重设计调了内容分档，
 * 不是原样翻倍就完事——三条纪律落在这里：
 *   ① 相邻两档的 blocks 必须不同（同样的东西放大只会产生空白）
 *   ② 相似族共用骨架但**不共用内容密度**（Apple 对 widget 的第一条规则：
 *      不要跨尺寸缩放内容，每个尺寸独立设计版式）
 *   ③ 阅读方向决定分栏：列表类走 listCols（≤2 栏），横向对比类走 contentCols
 */

export interface Form {
  /** 显示哪些块，按渲染顺序 */
  blocks: string[]
  /** 列表类：最多显示几条 */
  maxItems?: number
  /** 放不下的处理：截断并写明还剩几条 / 只报个数 / 不会溢出 */
  overflow?: 'more' | 'count' | 'none'
  /** 内容分几栏 */
  cols?: number
  /** 互斥的渲染方式（能力目录的 grid/list/count）。跟 blocks 不同——它不是叠加的 */
  mode?: string
  /** 天气逐时条显示几小时。跟 maxItems 分开——同一张卡上逐时和多日是两组数据 */
  hours?: number
  /** 天气多日预报显示几天。**不复用 maxItems**——那是"列表放几条"的语义 */
  days?: number
}

export type FormFn = (cols: number, rows: number) => Form


/** 一屏 12×8 = 96 单元。24 单元 ≈ 屏幕 1/4，是"放得下一段解释"的分界 */
const area = (c: number, r: number) => c * r


/**
 * 导航卡。转向条（还有多远 · 做什么 · 上哪条路）是命根子，任何形状都保。
 *
 * 三档：strip(4×2) → hall(6×6) → stage(8×8)。
 * **中档必须有地图**（2026-08-14 实拍反馈：没有地图的中档看着非常空）——
 * 原来的判据要求宽 ≥8，而中档 tower 只有 4 列宽，条件永远不满足，
 * 于是干脆不画，留下一大片空白。换成 hall（1208×741）之后地图有 500px 高，
 * 正好是"前方一段路"的形状。
 *
 * `lane` 车道指引是 Android for Cars 数据模型里的一等组件（路口最关键的信息
 * 是"在哪条道"），我们一直没有。`eta` 里的**到达时刻**同理是 TravelEstimate
 * 的必填字段——人想知道的是"几点到"不是"还要多久"，所以最小档也给。
 */
export const navForm: FormFn = (c, r) => {
  /**
   * dest（目的地名）是**恒在块**：转向指令要有 navigation.nextInstruction
   * 才画得出来，而刚设完目的地还没取到指引、或没有高德 Key 的降级演示时
   * 它就是空串——最小档只声明 turn 的话，块全 display:none，
   * 桌面上留一条只有边框的空玻璃条，用户不知道这是导航卡还是渲染坏了。
   */
  const blocks = ['dest', 'turn']
  // 地图要"看得出路"：宽度撑得开 **且** 高度不是一条扁缝
  if (c >= 6 && r >= 6) blocks.push('map')
  // 车道指引跟着地图走——没地图的扁条档放不下五个车道箭头
  if (c >= 6 && r >= 6) blocks.push('lane')
  /**
   * 下一步预告（「然后直行 1.2km」）只给最大档。
   *
   * 它是 hall 和 stage 唯一的内容差别 —— 两档宽高比相同（1.63）、
   * 共用一套骨架，但**内容密度必须不同**，否则 stage 就是 hall 放大后
   * 留一片空白（Apple 对 widget 的第一条规则：不要跨尺寸缩放内容）。
   */
  if (c >= 8 && r >= 8) blocks.push('then')
  // 到达时刻任何档都给
  blocks.push('eta')
  return { blocks }
}

/**
 * 车控卡。车身图要竖向空间。
 *
 * 三档 tile(2×4) → box(4×4) → tower(4×8)，只有最高的 tower 画车身图。
 * 这块图以前要求 `r >= 4`，而车控卡的档位只有 1/2/2 行——**条件不可能满足**，
 * 图画好了从没在屏幕上出现过（2026-08-14 代码审查发现的死代码）。
 */
export const controlForm: FormFn = (c, r) => {
  const blocks: string[] = []
  if (r >= 8 && c >= 4) blocks.push('vehicle')
  blocks.push('items')
  const cols = listCols(c)
  /**
   * 窄卡（tile 的画布只有 335px）放不下"标签 + 数值"并排，只能竖着堆，
   * 一条就吃掉两行。与其挤四条挤成一团，不如老实只显示**主控项** ——
   * 设计里 tile 档就是"一个部位 + 一个大数值"，跟 box 的四条列表是两种东西。
   * （不这么分的话 tile 和 box 的形态完全相同，那一档等于白给）
   */
  const maxItems = c >= 4 ? Math.max(2, capacityOf(cols, r)) : 1
  return { blocks, maxItems, overflow: 'more', cols }
}

/**
 * MRTR 确认卡。"要做什么"和"怎么答"任何档位都得说清 ——
 * 少了前者用户不知道在确认什么，少了后者他不知道该说"确认"还是"好"。
 * "为什么要确认"是解释性内容，小档先砍。
 *
 * 两档 box(4×4) → wide(6×4)。**判据从面积改成宽度**：why 是一行说明文字，
 * 它需要的是横向空间不是面积。
 */
export const confirmForm: FormFn = (c, _r) => {
  const blocks = ['what']
  if (c >= 6) blocks.push('why')
  blocks.push('hint')
  return { blocks }
}

/**
 * 执行结果。两档 chip(2×2) → box(4×4)：小档只有结论（「已开窗」），
 * 大档多一句说明。它本来就是一句话的卡，不该有第三档。
 */
export const feedbackForm: FormFn = (c, r) => {
  const blocks = ['text']
  if (area(c, r) >= 16) blocks.push('detail')
  return { blocks }
}

/**
 * 提示 / 拒绝卡。两档 tile(2×4) → wide(6×4)。
 *
 * **suggestion 是恒在块**——「拒绝必须携带机器可读原因」是项目核心原则之一，
 * 只说"不行"不说"怎么办"等于原则没落地。所以最小档不能是 chip（一行放不下两句），
 * 换成 tile 竖排：原因一行、建议一行。大档才多出"为什么"这层解释。
 */
export const noticeForm: FormFn = (c, _r) => {
  const blocks = ['text']
  if (c >= 6) blocks.push('why')
  blocks.push('suggestion')
  return { blocks }
}

/**
 * 候选列表。截断策略在这里定，车机屏和 desk.summary() 都读它。
 *
 * 三档 box(4×4) → tower(4×8) → court(6×8)，**全是竖的**（2026-08-14 实拍反馈）。
 * 原来最大档是 12×4 的横条、16 条铺 4 栏，每条 600px 宽却只有 100px 高，
 * 比例失调，而且眼睛要在四列之间来回跳。列表的阅读方向本来就是从上往下。
 */
export const listForm: FormFn = (c, r) => {
  const n = listCapacity(c, r)
  return { blocks: ['items'], maxItems: n, overflow: n > 0 ? 'more' : 'count', cols: listCols(c) }
}

/** 通用信息卡（info / generic）。三段都在契约里，别再静默丢数据 */
const genericForm: FormFn = (c, r) => {
  const blocks = ['text']
  if (area(c, r) >= 16) blocks.push('items', 'actions')
  const cols = contentCols(c)
  return { blocks, maxItems: Math.max(2, capacityOf(cols, r)), overflow: 'more', cols }
}

/**
 * 播放器卡。封面、歌名、播控任何档位都在——封面是媒体卡的身份证，播控是它存在的
 * 意义，这三样砍了就不是播放器了（实拍：最小档只剩一行歌名，用户直接点名）。
 *
 * 三档 box(4×4) → hall(6×6) → court(6×8)。原来最大档跟中档的 blocks **完全相同**
 * 而高度翻倍，一半是空的（2026-08-14 代码审查）。现在每档都有独占的块：
 * `bar` 进度 · `mix` 随机/循环/收藏 · `vol` 音量 · `next` 队列预告 · `queue` 完整队列。
 */
/**
 * 播放器卡三档（重设计 v2，2026-08-19）：三段式骨架——
 * 顶行元信息带（meta）/ 主区（art+title+sub+aux+next）/ 底带（bar+ctl+extras）。
 * aux 是辅助内容区：音乐放歌词两句、播客放 shownotes、电台放电平动画——
 * 装什么由 SOURCE_STYLE 查表，形态只管"这一档有没有这个槽"。
 */
export const mediaForm: FormFn = (c, r) => {
  const a = area(c, r)
  // 命根子四件：封面 / 标题 / 进度 / 主控，最小档也全有
  const blocks = ['art', 'title', 'sub', 'bar', 'ctl']
  if (a >= 36) blocks.push('meta', 'aux', 'next', 'extras')   // hall 起：元信息带+辅助区+预告+次控
  if (r >= 8) blocks.push('queue')   // court 起：完整队列——变大只加不减（形状变大不掉块）
  return { blocks }
}

/**
 * 天气卡。三档 tile(2×4) → wide(6×4) → band(12×4)。
 *
 * **主角是逐小时不是多日**（2026-08-14 调研结论）：车里最想知道的是
 * "接下来一两小时会不会下雨"，5 天预报是手机首页的逻辑。通行判据是
 * 「一秒读懂：当前温度、下一次降水、今日温差、预警状态」。
 *
 * `range`（今日最高/最低）是最基本的一项，之前连大档都没有，现在恒在。
 * 5 天那个分支原来要求 `a >= 32` 而最大档面积只有 24，**永远走不到**——
 * 判据改成看宽度（只有通栏才排得下 5 天）。
 */
export const weatherForm: FormFn = (c, r) => {
  const a = area(c, r)
  const blocks = ['temp', 'range']
  const hours = c >= 12 ? 12 : c >= 6 ? 6 : 0
  if (hours > 0) blocks.push('hourly')
  const days = c >= 12 ? 5 : 0
  if (days > 0) blocks.push('forecast')
  if (a >= 24) blocks.push('detail')   // 体感 · 风力 · 湿度
  /**
   * 天数走 `days` 不走 `maxItems`。`maxItems` 的语义是"这张列表放得下几条"，
   * 天气卡不是列表——混用的后果是 suggestSize 把它当条数计量的模板，
   * 拿"0 条内容"去反查，挑出最小的 tile 档（实际它该听 defaultSize）。
   */
  return { blocks, days, cols: days || 1, hours }
}

/**
 * 能力目录。33 项塞进一格是不可能的，老实报个数。
 * grid/list/count 是三种**互斥的渲染方式**，走 `mode` 不走 `blocks` ——
 * blocks 那条"档位变大不掉块"的单调性才管得住。
 *
 * 两档 court(6×8) → full(12×8)。砍掉了最小档：用户问"你能做什么"，
 * 屏幕回答一个数字「33 项」不是答案。
 */
export const capForm: FormFn = (c, r) => {
  const a = area(c, r)
  // 网格看"面积够 且 宽度撑得起多栏"
  const mode = a >= 48 && c >= 6 ? 'grid' : a >= 24 ? 'list' : 'count'
  // 按**实际列数**算容量。list 模式只有一列，照多列的容量给就会切掉半行——
  // 用户看到一条被拦腰截断的能力比不显示更糟，他会以为那就是全部
  const cols = mode === 'grid' ? contentCols(c) : 1
  return {
    blocks: ['groups'], mode, cols,
    maxItems: mode === 'count' ? 0 : capacityOf(cols, r),
    overflow: mode === 'count' ? 'count' : 'more',
  }
}

/**
 * 绘本卡。**画面和一句话是命根子**，任何档位都保 —— 少了画面不是绘本，
 * 少了文字识字的孩子就没得看。
 *
 * 三档按**宽度**分，因为差别在"旁边还放不放得下东西"：
 *   court(6 宽) 竖版，画面在上文字在下，只有进度点
 *   stage(8 宽) 行驶中默认，多出章节标记（「妞妞和小熊的雨天 · 第一章」）
 *   full(12 宽) 停车时沉浸，画面占左侧，右侧留出「这一页学到的词」和播控
 *
 * `dots` 是进度点。**不显示总数** —— 故事是开放的（孩子说结束才结束），
 * 标了总数等于告诉孩子"还有三页就没了"，他会开始倒计时而不是听故事。
 */
export const storybookForm: FormFn = (c, _r) => {
  /**
   * **翻页键三档都在**（2026-08-14 实拍反馈「也没有翻页」）。
   * 原来 `ctl` 卡在 c>=12，而默认档是 stage（8 列）—— 用户看到的那张卡上
   * 根本没有翻页键。翻页之于绘本等同于播控之于播放器卡，是命根子不是奢侈品。
   */
  const blocks = ['art', 'line', 'dots', 'ctl']
  /**
   * **够宽就左图右文**（2026-08-14 实拍：「图片没有显示全，建议左图右文，
   * 文字可以稍微多一点」）。上图下文在 1.63 宽高比的卡上把图压成一条 ——
   * 要么裁图要么很小。左右分栏之后图能整张放下，右边那一栏又高又窄，
   * 正好放两三句话。
   *
   * court(6×8) 本来就是竖卡，强行分栏文字栏只剩两百来像素，维持上图下文。
   */
  if (c >= 8) blocks.push('chapter', 'side')
  if (c >= 12) blocks.push('lesson')
  return { blocks }
}

/**
 * 轮播卡。三档的差异是**每页几张**，不是有没有副标题 ——
 * 副标题是条目自己的属性（有就显示），拿它当档位差异会出现
 * "放大反而掉块"（hall 6×6 有、panel 8×4 没有，而 panel 更大）。
 *
 * hall(6×6) 竖版排 2×2 四张大图；panel(8×4) 一行三张；band(12×4) 一行五张。
 * `page` 是**屏内展示状态**，不进桌面仲裁 —— 每 5 秒推进一页要是走 desk，
 * 就是每 5 秒触发一次全屏重排。
 */
export const carouselForm: FormFn = (c, r) => {
  const cols = c >= 12 ? 5 : c >= 8 ? 3 : 2
  const rows = r >= 6 ? 2 : 1               // 竖版格子摞两行
  return { blocks: ['items'], maxItems: cols * rows, cols, overflow: 'more' }
}

/** 对比卡：列数由宽度定。**横向并列比较**，栏数越多越好，走 contentCols */
export const compareForm: FormFn = (c, _r) => {
  const blocks = ['columns']
  if (c >= 8) blocks.push('badge')        // 「最快」「＋4 分」这类角标
  return { blocks, maxItems: contentCols(c), cols: contentCols(c), overflow: 'more' }
}

/** 进展卡：竖的。大档多出子进度条与说明 */
export const progressForm: FormFn = (c, r) => {
  const blocks = ['items']
  if (r >= 8) blocks.push('detail', 'bar')
  return { blocks, maxItems: capacityOf(1, r), cols: 1, overflow: 'more' }
}

/** 指标卡：一个数字。大档补趋势和进度条 */
export const metricForm: FormFn = (c, r) => {
  const a = area(c, r)
  const blocks = ['value']
  if (a >= 8) blocks.push('sub')
  if (a >= 16) blocks.push('bar', 'trend')
  return { blocks }
}

/** 图表卡：柱子数量按宽度给，大档补坐标说明 */
export const chartForm: FormFn = (c, _r) => {
  const blocks = ['plot']
  if (c >= 6) blocks.push('axis')
  if (c >= 8) blocks.push('legend')
  return { blocks, maxItems: c >= 8 ? 12 : c >= 6 ? 7 : 5, overflow: 'more' }
}

/**
 * 图片卡。三档 box(1.64 横) → frame(1.08 近正方) → hall(1.63 横，更大)。
 * frame 才配得上照片本来的比例；hall 宽出来的地方放来源/坐标那行小字。
 */
export const imageForm: FormFn = (c, r) => {
  const blocks = ['pic']
  if (area(c, r) >= 24) blocks.push('caption')
  if (c >= 6) blocks.push('meta')     // 来源 · 坐标 · 距离，宽了才放得下
  return { blocks }
}

/** 模板的形态函数。加模板 = 加一条，不改调用方 */
export const CARD_FORMS: Record<string, FormFn> = {
  nav: navForm,
  control: controlForm,
  confirm: confirmForm,
  feedback: feedbackForm,
  notice: noticeForm,
  list: listForm,
  // 台下清单长得就是列表卡——不进这张表的话 summary 按 genericForm 算可见条数、
  // 车机屏按 listForm 画，同一张卡两套账（当前数值恰好相等，纯属侥幸）
  stagedlist: listForm,
  automation: listForm,
  info: genericForm,
  media: mediaForm,
  weather: weatherForm,
  capability: capForm,
  storybook: storybookForm,
  carousel: carouselForm,
  compare: compareForm,
  progress: progressForm,
  metric: metricForm,
  chart: chartForm,
  image: imageForm,
  generic: genericForm,
}

/** 查不到就按 generic 走——白卡比不显示更糟 */
export const formOf = (template: string, c: number, r: number): Form =>
  (CARD_FORMS[template] ?? genericForm)(c, r)

import { CARD_TEMPLATES, COMMON_SIZES } from './cards'
import { dimsOf, cellsOfTier } from './grid'

/**
 * 内容 → 建议尺寸（形态表的**反查**，不是第二套公式）。
 *
 * 给定条数，在模板允许的形状里按面积从小到大找第一个装得下的；
 * 全装不下就取最大档（截断策略接手）。3 条候选不再占半屏空一半，
 * 12 条不再默认被截 4 条。
 *
 * **非列表模板走 defaultSize**（2026-08-14 代码审查修）：它靠 `maxItems` 挑档，
 * 而播放器、天气、导航、信息卡都没有这个字段——循环一次都不进，
 * 直接返回最大档，"按内容挑尺寸"这个机制对一半模板是失效的。
 *
 * 这是"建议"层（物理 > 意愿 > 建议里最弱的一级）：
 * 调用方显式给了尺寸就轮不到它，仲裁要压缩也拦不住。
 */
export function suggestSize(templateId: string, count: number): string {
  const tmpl = CARD_TEMPLATES.find(t => t.id === templateId)
  const allowed = [...(tmpl?.sizes ?? COMMON_SIZES)]
    .sort((a, b) => cellsOfTier(a) - cellsOfTier(b))
  let sawCapacity = false
  for (const z of allowed) {
    const max = formOf(templateId, ...dimsOf(z)).maxItems
    if (max === undefined) continue
    sawCapacity = true
    if (max >= count) return z
  }
  // 这个模板压根不按条数计量（播放器、天气、导航……）——听模板自己的建议
  if (!sawCapacity) return tmpl?.defaultSize ?? allowed[allowed.length - 1]
  return allowed[allowed.length - 1]
}
