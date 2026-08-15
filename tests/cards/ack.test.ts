import { describe, it, expect } from 'vitest'
import { ackLine } from '../../src/cards/summary'

/**
 * ══════════ 回执压成一句人话 ══════════
 *
 * 车控回执从卡片改走横幅之后，`{title, items:[{label,value,unit}]}` 这个
 * 卡片形状要变成横幅能显示的一行字。
 *
 * 抽成纯函数才测得了 —— 而且它是**展示逻辑不是业务逻辑**：
 * 不认识"车窗""空调"，只认 items 的形状。
 */
describe('把车控回执压成一行', () => {
  const win = {
    title: '车窗',
    items: [
      { label: '主驾', value: 60, unit: '%' },
      { label: '副驾', value: 0, unit: '%' },
    ],
  }

  it('每项拼成「名 值单位」，中间点分隔', () => {
    expect(ackLine(win)).toBe('主驾 60% · 副驾 0% ')
  })

  it('布尔值说人话，不是 true/false', () => {
    expect(ackLine({ items: [{ label: '内循环', value: true }, { label: 'AUTO', value: false }] }))
      .toBe('内循环 开 · AUTO 关 ')
  })

  it('没有单位就不硬加', () => {
    expect(ackLine({ items: [{ label: '出风', value: '吹脸' }] })).toBe('出风 吹脸 ')
  })

  /** 横幅是一行，项太多要收口 —— 但**不能默默截断**，得说还有几项 */
  it('项太多时截断并说清还有几项', () => {
    const many = { items: Array.from({ length: 9 }, (_, i) => ({ label: 'L' + i, value: i })) }
    const s = ackLine(many)
    expect(s).toContain('还有')
    expect(s.split('·').length, '截到四五项').toBeLessThanOrEqual(6)
  })

  it('没有 items 时返回空串，让调用方退回标题', () => {
    expect(ackLine({ title: '车窗' })).toBe('')
    expect(ackLine({} as any)).toBe('')
    expect(ackLine(null as any)).toBe('')
  })

  /** 坏数据不把横幅带崩 —— data builder 出错时宁可少显示 */
  it('条目缺字段时跳过它，不渲染 undefined', () => {
    expect(ackLine({ items: [{ label: '主驾', value: 60, unit: '%' }, {} as any, null as any] }))
      .toBe('主驾 60% ')
  })
})
