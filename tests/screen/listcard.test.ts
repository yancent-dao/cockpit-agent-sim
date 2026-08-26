import { describe, it, expect } from 'vitest'
import { listBody } from '../../src/screen/render'

/**
 * 列表条目两行堆叠（2026-08-25 实拍：车型调研卡 label 被截成「比亚迪…」
 * 「智…」——label 和 sub 挤在同一 flex 行、都可收缩，sub 长就把 label
 * 吃光）。「list 升级四点」在设计稿上定过（label/sub 两行堆叠、去斑马纹
 * 改发丝线），代码一直没落实，这次落实。
 */
describe('listBody 条目结构', () => {
  const items = [
    { label: '比亚迪海狮07EV', sub: '5月13日上市 · 中大型纯电SUV · 23-33万 · 第二代刀片电池' },
    { label: '智己L6', sub: '5月上市 · 中大型纯电轿车 · 23-33万', right: '¥23万' },
  ]

  it('label 与 sub 堆叠在同一个列容器里——sub 再长也挤不到 label', () => {
    const html = listBody(items, { maxItems: 8 })
    expect(html).toContain('class="ltx"')
    // label 在 ltx 内、sub 也在 ltx 内（同一容器分两行）
    expect(html).toMatch(/<div class="ltx"><b>比亚迪海狮07EV<\/b><small>/)
  })

  it('right 值仍在行尾', () => {
    const html = listBody(items, { maxItems: 8 })
    expect(html).toContain('class="rr"')
  })

  it('无 sub 的条目不留空 small', () => {
    const html = listBody([{ label: '只有名字' }], { maxItems: 8 })
    expect(html).not.toContain('<small></small>')
  })
})
