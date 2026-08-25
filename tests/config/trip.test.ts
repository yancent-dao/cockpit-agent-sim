import { describe, it, expect } from 'vitest'
import { CARD_TEMPLATES } from '../../src/config/cards'
import { CARD_FORMS } from '../../src/config/forms'
import { INTERACTIONS } from '../../src/config/interactions'
import { dimsOf } from '../../src/config/grid'

/**
 * 融合旅行卡 trip（2026-08-25，设计稿 artifact「旅行助手 HMI」page-fusion）。
 *
 * 一张卡 = 一次旅行在屏幕上的家：攻略（头图+行前准备+Day 轮播）→ 盯价
 * （+价格块，轮播压成单行）→ 到价（+决策条），同 key 原地生长。
 * guide / itinerary 两个模板**退役**并入本卡——留着它们，模型就还有
 * 两条老路可走，"同一张卡"就名存实亡。
 */

describe('trip 模板注册', () => {
  const t = CARD_TEMPLATES.find(x => x.id === 'trip')

  it('存在，且是机制生成（systemOnly）——攻略数据走 travel.plan 进仓，模型不直接建卡', () => {
    expect(t).toBeTruthy()
    expect(t!.systemOnly).toBe(true)
  })

  it('三档 hall / court / stage——行驶一档、停车两档', () => {
    expect(t!.sizes).toEqual(['hall', 'court', 'stage'])
    expect(t!.defaultSize).toBe('court')
  })

  it('guide 与 itinerary 已退役', () => {
    expect(CARD_TEMPLATES.find(x => x.id === 'guide')).toBeUndefined()
    expect(CARD_TEMPLATES.find(x => x.id === 'itinerary')).toBeUndefined()
    expect(CARD_FORMS['guide']).toBeUndefined()
    expect(CARD_FORMS['itinerary']).toBeUndefined()
    expect(INTERACTIONS['guide']).toBeUndefined()
    expect(INTERACTIONS['itinerary']).toBeUndefined()
  })
})

describe('tripForm：档位只决定每帧的密度，轮播机制不变', () => {
  const form = (size: string) => CARD_FORMS['trip']!(...dimsOf(size as any))

  it('hall（行驶中）：基础三块——头部在渲染层退化成色条，帧退化成单行', () => {
    expect(form('hall').blocks).toEqual(['hero', 'days', 'prices'])
  })

  it('court：加块不换块——头图长满、帧长成时间轴、行前准备与决策条进场', () => {
    expect(form('court').blocks).toEqual(['hero', 'days', 'prices', 'herofull', 'prep', 'dayfull', 'decide'])
  })

  it('stage：再加双列——相邻档内容必须不同', () => {
    expect(form('stage').blocks).toEqual(['hero', 'days', 'prices', 'herofull', 'prep', 'dayfull', 'daycols', 'decide'])
  })
})

describe('trip 交互声明', () => {
  it('点条目走 answer 路由——点某天/点价格块 = 说了那句话', () => {
    const acts = INTERACTIONS['trip'] ?? []
    expect(acts.some(a => a.on === 'tap:item' && a.route === 'answer')).toBe(true)
  })
})
