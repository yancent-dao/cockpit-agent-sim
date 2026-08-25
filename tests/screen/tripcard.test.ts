import { describe, it, expect } from 'vitest'
import { cardBody } from '../../src/screen/render'

/**
 * 融合旅行卡 v3 的渲染契约（2026-08-25 用户拍板：轮播退役，滚动单页）。
 *
 * 攻略是**一页从上往下滑**的内容：days 全部纵向展开（stage 双列），
 * `.bd` 自带滚动；hall 行驶档只给单行摘要——行驶中不给滚动是 HMI 纪律。
 * 分步共建的四个阶段全是数据形状：lines（选线）→ days（草稿/全文）→
 * flight/stays（盯价）→ decide（到价）。
 */

const body = (size: string, data: any) =>
  cardBody({ id: 'x', template: 'trip', size, kind: 'task', data } as any)

const DAYS = [
  { title: '飞昆明 · 转大理', stay: '大理古城',
    stops: [
      { time: '14:00', name: '长水机场落地', note: '动车 2 小时直达大理' },
      { time: '18:30', name: '大理古城夜逛', note: '人民路小吃一路吃' },
    ],
    trans: ['动车 · 提前一天买票'] },
  { title: '洱海环湖 · 喜洲', stay: '大理古城',
    stops: [{ time: '09:00', name: '租电动车环洱海', note: '逆时针光线好' }] },
  { title: '去丽江 · 丽江古城', stay: '丽江', cityChange: true,
    stops: [{ time: '10:00', name: '动车去丽江' }] },
]

const LINES = [
  { name: '滇西北 · 雪山古城线', route: '昆明 → 大理 → 丽江', days: '6–8 天', note: '经典走法' },
  { name: '滇南 · 雨林风情线', route: '昆明 → 西双版纳', days: '5–6 天', note: '冬天最舒服' },
]

const GUIDE = {
  title: '大理丽江', dest: '云南', sub: '5 天 · 大理 + 丽江', badge: '细排好了',
  prep: ['高原防晒', '早晚带外套'], days: DAYS, foot: '来源：近 3 个月高频攻略',
}

const WATCH = {
  ...GUIDE, dday: 'D-12',
  wx: [
    { date: '2026-10-01', weather: '晴', hi: 21, lo: 9 },
    { date: '2026-10-02', weather: '小雨', hi: 18, lo: 8 },
    null,                                        // 窗外的日子：缺席不编造
  ],
  flight: { label: '机票 · 成都 ⇄ 昆明', text: '¥980', delta: -65,
    points: [1200, 1150, 1100, 1050, 980] },
  stays: [
    { label: '大理古城', range: 'D1–2', text: '¥368 / 晚', delta: 15, watchId: 'w1', points: [340, 355, 368] },
    { label: '丽江古城', range: 'D3–5', text: '¥426 / 晚', delta: -22, watchId: 'w2', points: [460, 440, 426] },
  ],
}

const HIT = {
  ...WATCH,
  decide: { question: '机票到你说的价了（¥980），现在定吗？', options: ['去订机票', '继续盯着'] },
}

describe('自带滚动容器（2026-08-25 实拍：.bd 的 flex-end 把溢出内容推进顶部滚不到的区域，头图/行前/D1 行头全被吞）', () => {
  it('全部内容包在 tppage 里——它自己滚，从顶部开始', () => {
    const html = body('court', WATCH)
    expect(html.startsWith('<div class="tppage">')).toBe(true)
    expect(html.trimEnd().endsWith('</div>')).toBe(true)
    expect(html.indexOf('tphero')).toBeGreaterThan(html.indexOf('tppage'))
  })

  it('hall 同样包着——布局统一从顶部开始', () => {
    expect(body('hall', WATCH).startsWith('<div class="tppage">')).toBe(true)
  })
})

describe('选线阶段：目的地宽泛先收敛', () => {
  const html = body('court', { title: '云南', dest: '云南', lines: LINES })

  it('线路各一块：名称 · 城市链 · 天数 · 适合谁，点一条 = 说了那句话', () => {
    expect(html.match(/tpline-item/g)!.length).toBe(2)
    expect(html).toContain('滇西北 · 雪山古城线')
    expect(html).toContain('昆明 → 大理 → 丽江')
    expect(html).toContain('冬天最舒服')
    expect(html.match(/data-act="tap:item"/g)!.length).toBeGreaterThanOrEqual(2)
  })

  it('选线阶段没有 Day 也没有价格块', () => {
    expect(html).not.toContain('tpday')
    expect(html).not.toContain('tpprice')
  })
})

describe('court：攻略全文单页纵向铺开', () => {
  const html = body('court', GUIDE)

  it('头图 + 行前准备 + 全部天展开——没有轮播没有指示器', () => {
    expect(html).toContain('tphero')
    expect(html).toContain('高原防晒')
    expect(html.match(/tpday\b/g)!.length).toBe(DAYS.length)
    expect(html).not.toContain('data-n=')
    expect(html).not.toContain('tpdots')
    expect(html).not.toContain('tpcar')
  })

  it('每天是完整时间轴：站点 + 介绍 + 站间交通 + 宿哪', () => {
    expect(html).toContain('14:00')
    expect(html).toContain('动车 2 小时直达大理')
    expect(html).toContain('动车 · 提前一天买票')
    expect(html).toContain('宿 大理古城')
  })

  it('换城日琥珀标出', () => {
    expect(html).toContain('is-move')
  })
})

describe('每天带天气（确认后）', () => {
  const html = body('court', WATCH)

  it('天气在当天行头：天气词 + 高低温', () => {
    expect(html).toContain('晴')
    expect(html).toContain('21° / 9°')
    expect(html).toContain('小雨')
  })

  it('窗外的日子缺席不编造——第三天没有天气', () => {
    expect(html.match(/tpwx/g)!.length).toBe(2)
  })
})

describe('盯价阶段：价格块置顶，攻略全文在下', () => {
  const html = body('court', WATCH)

  it('机票块带曲线、住宿分段各一行各带走势', () => {
    expect(html).toContain('¥980')
    expect(html.match(/polyline/g)!.length).toBeGreaterThanOrEqual(3)
    expect(html.match(/tpstayrow/g)!.length).toBe(2)
  })

  it('价格块出现在第一天之前——置顶', () => {
    expect(html.indexOf('tpprices')).toBeLessThan(html.indexOf('class="tpday"'))
  })

  it('攻略全文还在（不是收起）', () => {
    expect(html.match(/tpday\b/g)!.length).toBe(DAYS.length)
    expect(html).toContain('动车 2 小时直达大理')
  })
})

describe('到价阶段：决策条', () => {
  it('琥珀决策条在价格块与全文之间', () => {
    const html = body('court', HIT)
    expect(html).toContain('tpdecide')
    expect(html.indexOf('tpdecide')).toBeGreaterThan(html.indexOf('tpprices'))
    expect(html.indexOf('tpdecide')).toBeLessThan(html.indexOf('class="tpday"'))
  })
})

describe('hall：行驶中不给滚动', () => {
  const html = body('hall', WATCH)

  it('色条 + 价格大块 + 首日一行——没有全文没有时间轴', () => {
    expect(html).toContain('tpstrip')
    expect(html).toContain('¥980')
    expect(html).toContain('飞昆明 · 转大理')
    expect(html).not.toContain('class="tpday"')
    expect(html).not.toContain('14:00')
    expect(html).not.toContain('polyline')
  })
})

describe('stage：全文双列铺开', () => {
  it('相邻档内容不同靠双列', () => {
    expect(body('stage', WATCH)).toContain('tpcols')
    expect(body('court', WATCH)).not.toContain('tpcols')
  })
})

describe('缺数据不炸', () => {
  it('没有 days 没有 lines 也能渲染', () => {
    const html = body('court', { title: '云南', dest: '云南' })
    expect(html).toContain('云南')
  })
})
