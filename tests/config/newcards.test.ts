import { describe, it, expect } from 'vitest'
import { CARD_TEMPLATES } from '../../src/config/cards'
import { CARD_FORMS } from '../../src/config/forms'
import { INTERACTIONS } from '../../src/config/interactions'
import { cardBody } from '../../src/screen/render'
import { dimsOf } from '../../src/config/grid'

/**
 * ══════════ 新增的六张模板 ══════════
 *
 * 判据统一是**「有真实数据源在用，且现有模板会渲染错」** ——
 * 不满足就不加，模板数量本身也是成本。时间线卡、评分卡、表单卡都想过，
 * 但列表卡加生成式卡已经能表达，且没有现成数据源在等着它们。
 */

const NEW = ['carousel', 'compare', 'progress', 'metric', 'chart', 'image']
const t = (id: string) => CARD_TEMPLATES.find(x => x.id === id)
const body = (id: string, size: string, data: any) =>
  cardBody({ id: 'x', template: id, size, kind: 'task', data } as any)

describe('六张都注册齐了', () => {
  it('模板 · 形态 · 交互三件套都有', () => {
    for (const id of NEW) {
      expect(t(id), `${id} 模板`).toBeTruthy()
      expect(CARD_FORMS[id], `${id} 形态函数`).toBeTruthy()
      expect(INTERACTIONS[id], `${id} 交互声明`).toBeTruthy()
    }
  })

  it('每张的相邻两档内容都不同', () => {
    for (const id of NEW) {
      const sizes = t(id)!.sizes!
      for (let i = 1; i < sizes.length; i++) {
        const a = JSON.stringify(CARD_FORMS[id](...dimsOf(sizes[i - 1])))
        const b = JSON.stringify(CARD_FORMS[id](...dimsOf(sizes[i])))
        expect(a, `${id} 的 ${sizes[i - 1]} 和 ${sizes[i]} 一样`).not.toBe(b)
      }
    }
  })
})

/**
 * **阅读方向决定卡片的长轴**（2026-08-14 立的纪律）。
 * 从上往下读的用竖卡，从左往右比的用横卡。
 */
describe('形状跟阅读方向对得上', () => {
  it('进展卡是竖的 —— 一条条往下看', () => {
    for (const s of t('progress')!.sizes!) {
      const [c, r] = dimsOf(s)
      expect(c / r, `${s}`).toBeLessThanOrEqual(1.5)
    }
  })

  it('对比卡和轮播卡是横的 —— 并排比 / 横向流', () => {
    for (const id of ['compare', 'carousel']) {
      const [c, r] = dimsOf(t(id)!.defaultSize)
      expect(c / r, `${id} 默认档`).toBeGreaterThan(1)
    }
  })

  it('指标卡用小档 —— 它是 chip / tile 真正的主人', () => {
    expect(t('metric')!.sizes).toContain('chip')
  })

  /** 新档 frame（1.08，全表最接近正方）的主要用户：照片和地图缩略图本来就是方的 */
  it('图片卡用得上近正方的 frame', () => {
    expect(t('image')!.sizes).toContain('frame')
  })
})

describe('渲染出来有东西', () => {
  const data: Record<string, any> = {
    carousel: { title: '附近的咖啡馆', items: [{ label: '三联', sub: '0.4km', image: 'a.jpg' }, { label: 'Manner', sub: '0.7km' }] },
    compare: { title: '三条路线', columns: [{ label: '推荐', rows: [{ k: '到达', v: '14:26' }] }, { label: '避拥堵', rows: [{ k: '到达', v: '14:30' }] }] },
    progress: { title: '后台任务', items: [{ label: '查行情', state: 'running', percent: 64 }, { label: '查天气', state: 'done' }] },
    metric: { title: '续航', value: 420, unit: '公里', sub: '电量 68%', percent: 68 },
    chart: { title: '近 7 天电耗', kind: 'bar', series: [{ label: '一', value: 12 }, { label: '二', value: 15 }] },
    image: { title: '宽窄巷子', url: 'x.jpg', caption: '距您 3.4 公里' },
  }

  it('每张在每个档位都渲染出非空内容', () => {
    for (const id of NEW)
      for (const s of t(id)!.sizes!)
        expect(body(id, s, data[id]).trim().length, `${id}@${s} 渲染成空的`).toBeGreaterThan(0)
  })

  it('轮播卡带翻页交互 —— 页码是屏内状态不进桌面仲裁', () => {
    expect(INTERACTIONS.carousel.some(d => d.on === 'tap:next')).toBe(true)
  })

  it('进展卡画得出状态点，不是跟列表卡一样一行字', () => {
    const h = body('progress', 'box', data.progress)
    expect(h, '跑着的和完成的必须看得出区别').toMatch(/running|done/)
  })

  it('图片卡缺图时不留白卡', () => {
    expect(body('image', 'box', { title: 'x', caption: 'y' }).length).toBeGreaterThan(0)
  })
})
