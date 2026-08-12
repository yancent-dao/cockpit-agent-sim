import { describe, it, expect } from 'vitest'
import { cardBody, blocksBody, tierClass, accentClass } from '../../src/screen/render'

const V = (template: string, data: any, size = '1/6') =>
  ({ template, size, title: data.title ?? '', data } as any)

/**
 * 诊断 1：卡片内容缩在左上角，下半张脸空着。
 *
 * 根因是 `.card` 里的内容按自然高度从上往下堆，剩下的空间无人认领。
 * 12×4 之后卡片可能是 4×2 也可能是 8×4，"自然高度"这个概念本身就不成立——
 * 必须让**内容去适应容器**，而不是容器等着内容。
 *
 * 两条规则：
 *   ① 块状均分：并列的数据渲染成块，`grid-auto-rows:1fr` 让它们平分剩余高度
 *   ② 数据落底：标题贴顶、主数值贴底，中间的空白被推到两者之间而不是堆在底部
 */
describe('块状均分：并列数据平分剩余高度', () => {
  const items = [
    { label: '主驾', value: 30, unit: '%' },
    { label: '副驾', value: 0, unit: '%' },
    { label: '左后', value: 100, unit: '%' },
  ]

  it('渲染成 .blocks 容器 + 每项一个 .blk', () => {
    const h = blocksBody(items, { cols: 2 })
    expect(h).toContain('class="blocks')
    expect((h.match(/class="blk/g) ?? []).length).toBe(3)
  })

  it('栏数由形态函数给，落到 class 上而不是内联 style', () => {
    expect(blocksBody(items, { cols: 2 })).toContain('c2')
    expect(blocksBody(items, { cols: 3 })).toContain('c3')
    expect(blocksBody(items, { cols: 1 })).not.toMatch(/\bc[23]\b/)
  })

  it('标签和数值分开成两段 —— 块内也要上下分离，不然又缩成一坨', () => {
    const h = blocksBody([{ label: '风量', value: 3, unit: '档' }], {})
    expect(h).toContain('class="lb"')
    expect(h).toContain('class="num"')
    expect(h).toContain('档')
  })

  it('有 pct 就画一条进度轨 —— 数字说"多少"，轨道说"在哪一段"', () => {
    expect(blocksBody([{ label: '主驾', value: 30, unit: '%', pct: 30 }], {})).toContain('class="trk"')
    expect(blocksBody([{ label: '出风', value: '吹脚' }], {})).not.toContain('class="trk"')
  })

  it('转义标签和数值 —— 数据来自模型，尖括号不能变成标签', () => {
    const h = blocksBody([{ label: '<b>x', value: '<img src=x onerror=alert(1)>' }], {})
    expect(h).not.toContain('<img')
    expect(h).not.toContain('<b>x')
  })

  it('0 是有效值，不能被当成空而不显示', () => {
    expect(blocksBody([{ label: '左后', value: 0, unit: '%' }], {})).toContain('>0<')
  })
})

/** 车控卡走块状均分——四扇窗的开度是典型的"并列数据" */
describe('车控卡接上块状均分', () => {
  it('每扇窗一个块', () => {
    const h = cardBody(V('control', {
      items: [{ label: '主驾', value: 30 }, { label: '副驾', value: 0 }],
    }, '1/3'))
    expect((h.match(/class="blk/g) ?? []).length).toBe(2)
  })
})

/**
 * 档位类：字号 = 字阶 × --u，一个类管住一整张卡的排版比例。
 * 之前是 22 条 `.sz-*` 硬怼 60 处 font-size —— 加一个档位要补 6 条规则。
 */
describe('档位类与语义色类', () => {
  it('老尺寸名映射到档位类', () => {
    expect(tierClass('1/6')).toBe('t-card')
    expect(tierClass('2/3')).toBe('t-stage')
    expect(tierClass('full')).toBe('t-full')
  })

  it('新档位名直接用', () => {
    expect(tierClass('chip')).toBe('t-chip')
    expect(tierClass('tower')).toBe('t-tower')
  })

  /**
   * 诊断 5：系统卡描边、提示底色、拒绝横幅全是 warning 橙，用户分不出三者。
   * 八类语义色各自成套，靠模板 + 紧急度定身份，不靠 kind——
   * kind 是**编排优先级**，跟"这张卡长什么样"是两码事。
   */
  it('导航是 brand，播放是 media，选择是 pick —— 序号圆点不跟转向条抢戏', () => {
    expect(accentClass('nav', {})).toBe('a-brand')
    expect(accentClass('media', {})).toBe('a-media')
    expect(accentClass('list', {})).toBe('a-pick')
  })

  it('紧急度盖过模板：同一张车控卡，报警时是 danger', () => {
    expect(accentClass('control', {})).toBe('a-info')
    expect(accentClass('control', { urgency: 'critical' })).toBe('a-danger')
    expect(accentClass('control', { urgency: 'warn' })).toBe('a-warn')
  })

  it('认不出的模板退到 sys，不会没有身份色', () => {
    expect(accentClass('从没见过的模板', {})).toBe('a-sys')
  })
})
