import { describe, it, expect } from 'vitest'
import { cardBody } from '../../src/screen/render'

/**
 * 融合旅行卡的渲染契约（2026-08-25）。
 *
 * 轮播是**纯 CSS**：渲染器把全部 Day 帧一次输出（绝对定位叠放），
 * `data-n` 标帧数，keyframes 在 screen.html 里按 n 轮转——零状态零计时器，
 * screen 层不出现任何业务逻辑。data.dayIdx 存在 = 用户锁定了帧
 * （"停在这页"/"看第三天"），只渲染那一帧，没有动画可谈。
 */

const body = (size: string, data: any) =>
  cardBody({ id: 'x', template: 'trip', size, kind: 'task', data } as any)

const DAYS = [
  { title: '大皇宫 · 卧佛寺 · 考山路', stay: '曼谷·考山路',
    stops: [
      { time: '09:00', name: '大皇宫', note: '门票 500 泰铢，要过膝着装' },
      { time: '11:30', name: '卧佛寺', note: '46 米卧佛' },
      { time: '19:00', name: '考山路夜市', note: '小吃一路吃过去' },
    ],
    trans: ['步行 10 分钟', '轮渡 5 泰铢'] },
  { title: '水上市场一日', stay: '曼谷·考山路',
    stops: [{ time: '08:00', name: '丹嫩沙多水上市场' }] },
  { title: '去芭提雅 · 格兰岛', stay: '芭提雅·海滩', cityChange: true,
    stops: [{ time: '08:30', name: '大巴去芭提雅', note: 'Ekkamai 东站发车' }] },
]

const GUIDE = {
  title: '曼谷', dest: '曼谷', sub: '5 天怎么玩 · 攻略给你摆好了',
  badge: '5 天 · 曼谷+芭提雅',
  prep: ['落地签可办', '换点泰铢', '电话卡机场有', '雨季带伞'],
  days: DAYS, foot: '来源：近 3 个月高频攻略',
}

const WATCH = {
  ...GUIDE, dday: 'D-12',
  flight: { label: '机票 · 成都 ⇄ 曼谷', text: '¥1,670', delta: -28,
    points: [2100, 2050, 1980, 1890, 1810, 1740, 1670] },
  stays: [
    { label: '曼谷 · 考山路', range: 'D1–3 · 3 晚', text: '¥638 / 晚', delta: 8, watchId: 'w1' },
    { label: '芭提雅 · 海滩', range: 'D4 · 1 晚', text: '¥520 / 晚', delta: -12, watchId: 'w2' },
  ],
}

const HIT = {
  ...WATCH,
  decide: { question: '机票到你说的价了（¥1,670），现在定吗？', options: ['去订机票', '继续盯着'] },
}

describe('court：攻略阶段', () => {
  const html = body('court', GUIDE)

  it('头图带目的地名与徽标', () => {
    expect(html).toContain('tphero')
    expect(html).toContain('曼谷')
    expect(html).toContain('5 天 · 曼谷+芭提雅')
  })

  it('行前准备 chips 全数上屏', () => {
    for (const p of GUIDE.prep) expect(html).toContain(p)
  })

  it('全部 Day 帧一次输出，data-n 标帧数，带指示器', () => {
    expect(html.match(/tpfr/g)!.length).toBeGreaterThanOrEqual(DAYS.length)
    expect(html).toContain('data-n="3"')
    expect(html).toContain('tpdots')
  })

  it('帧内是单日时间轴：站点 + 介绍 + 站间交通', () => {
    expect(html).toContain('09:00')
    expect(html).toContain('大皇宫')
    expect(html).toContain('门票 500 泰铢，要过膝着装')
    expect(html).toContain('步行 10 分钟')
  })

  it('换城日标出宿在哪段', () => {
    expect(html).toContain('芭提雅·海滩')
  })

  it('攻略阶段没有价格块也没有决策条', () => {
    expect(html).not.toContain('tpprice')
    expect(html).not.toContain('tpdecide')
  })
})

describe('dayIdx：用户锁定帧', () => {
  it('只渲染锁定的那一帧，没有轮播动画', () => {
    const html = body('court', { ...GUIDE, dayIdx: 2 })
    expect(html).toContain('去芭提雅 · 格兰岛')
    expect(html).not.toContain('大皇宫')
    expect(html).not.toContain('data-n=')
  })
})

describe('盯价阶段：同一张卡长出价格块', () => {
  const html = body('court', WATCH)

  it('机票块带现价、涨跌与迷你走势', () => {
    expect(html).toContain('tpprice')
    expect(html).toContain('¥1,670')
    expect(html).toContain('polyline')
  })

  it('分段住宿各一行——不同的地方住不同的酒店，各盯各的价', () => {
    expect(html.match(/tpstay/g)!.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('¥638 / 晚')
    expect(html).toContain('¥520 / 晚')
  })

  it('D-day 徽标顶替攻略徽标', () => {
    expect(html).toContain('D-12')
  })
})

describe('到价阶段：决策条', () => {
  it('琥珀决策条带问题与两个可点选项', () => {
    const html = body('court', HIT)
    expect(html).toContain('tpdecide')
    expect(html).toContain('机票到你说的价了')
    expect(html.match(/data-act="tap:item"/g)!.length).toBeGreaterThanOrEqual(2)
  })
})

describe('hall：行驶中一帧压成一行', () => {
  const html = body('hall', WATCH)

  it('没有头图，色条顶替', () => {
    expect(html).not.toContain('tphero')
    expect(html).toContain('tpstrip')
  })

  it('单行轮播帧照转', () => {
    expect(html).toContain('data-n="3"')
    expect(html).toContain('大皇宫 · 卧佛寺 · 考山路')
  })

  it('价格是大数字但没有曲线——扫一眼即走，曲线要停车看', () => {
    expect(html).toContain('tpprices')
    expect(html).toContain('¥1,670')
    expect(html).not.toContain('polyline')
  })
})

describe('stage：单日时间轴双列铺开', () => {
  it('相邻档内容不同靠双列版式', () => {
    expect(body('stage', WATCH)).toContain('tpcols')
    expect(body('court', WATCH)).not.toContain('tpcols')
  })

  it('到价态帧一律收单行（决策条是主角），stage 的单行帧带动线摘要——相邻档仍不同', () => {
    expect(body('court', HIT)).toContain('tpline')
    expect(body('stage', HIT)).toContain('tpline')
    expect(body('stage', HIT)).toContain('大皇宫 → 卧佛寺')   // 宽档的空间换成内容
    expect(body('court', HIT)).not.toContain('大皇宫 → 卧佛寺')
  })
})

describe('缺数据不炸', () => {
  it('没有 days 也能渲染（任务刚建、攻略还没来）', () => {
    const html = body('court', { title: '曼谷', dest: '曼谷' })
    expect(html).toContain('曼谷')
    expect(html).not.toContain('tpfr')
  })
})
