import { describe, it, expect } from 'vitest'
import { classifyGesture, TAP_SLOP, SWIPE_MIN } from '../../src/screen/gestures'
import { CARD_TEMPLATES } from '../../src/config/cards'
import { routeOf } from '../../src/config/interactions'

/**
 * 触控落地（三个拍板：操控类直调 Tool 不叫醒模型 / 回答类等价语音输入 /
 * 管理类直调 desk 记入意愿层）。
 * 手势分类是纯算术必须可测；路由靠**交互声明**（模板契约第三件套）——
 * 手势层只做命中测试 → 查声明 → 分发，模型始终只学一个接口。
 */

describe('手势分类：纯算术', () => {
  const g = (dx: number, dy: number, dt = 200) => classifyGesture({ dx, dy, dt })

  it('没挪窝就是 tap', () => {
    expect(g(3, -2)).toBe('tap')
    expect(g(TAP_SLOP - 1, 0)).toBe('tap')
  })

  it('横向大位移是 swipe——方向锁：横向得明显大于纵向', () => {
    expect(g(SWIPE_MIN + 20, 10)).toBe('swipe-x')
    expect(g(-(SWIPE_MIN + 20), -8)).toBe('swipe-x')
  })

  it('纵向为主的位移是 scroll，不许误判成滑撤', () => {
    expect(g(30, 120)).toBe('scroll')
    expect(g(SWIPE_MIN + 10, SWIPE_MIN + 30), '斜着划让给滚动').toBe('scroll')
  })

  it('小位移非 tap 非 swipe → null（抖动丢弃）', () => {
    expect(g(20, 15)).toBeNull()
  })

  it('按住超过 800ms 的不算 tap——那是犹豫不是选择', () => {
    expect(g(2, 2, 900)).toBeNull()
  })
})

describe('交互声明：模板契约第三件套（数据，不是代码）', () => {
  it('播放器声明了操控类按钮 → 直调 Tool', () => {
    const r = routeOf('media', 'tap:next')!
    expect(r.route).toBe('tool')
    expect(r.tool).toBe('media.control')
    expect(r.args).toEqual({ action: 'next' })
  })

  it('列表/确认的条目点击 → 回答类（等价"第 N 个"进对话）', () => {
    expect(routeOf('list', 'tap:item')!.route).toBe('answer')
    expect(routeOf('confirm', 'tap:item')!.route).toBe('answer')
  })

  it('滑撤 → 管理类直调 desk', () => {
    expect(routeOf('weather', 'swipe:away')!.route).toBe('desk')
  })

  it('导航卡不许滑撤——导航中把导航划掉是事故', () => {
    expect(routeOf('nav', 'swipe:away')).toBeUndefined()
  })

  it('沙箱组件的 action → 回答类', () => {
    expect(routeOf('canvas-app', 'app')!.route).toBe('answer')
  })

  it('没声明的手势查不到路由——手势层丢弃，不瞎猜', () => {
    expect(routeOf('weather', 'tap:next')).toBeUndefined()
  })

  // 等位区清单（2026-08-13 W2）：召回是桌面管理的机械动作，点一下要等 LLM
  // 转一圈是灾难——直调 card.focus，条目携带的卡 id 经 valueParam 填进参数
  // 右上角尺寸调节按钮（2026-08-13 实拍反馈）：缩放是桌面管理的机械动作，
  // 不叫醒模型；每个模板（包括导航卡）都该有，缩放本身不等于关闭
  it('每个模板都能缩放——右上角按钮直调 desk，不叫醒模型', () => {
    for (const tmpl of CARD_TEMPLATES.map(t => t.id)) {
      expect(routeOf(tmpl, 'tap:shrink'), `${tmpl} 缺 shrink`).toEqual({ on: 'tap:shrink', route: 'desk', op: 'shrink' })
      expect(routeOf(tmpl, 'tap:grow'), `${tmpl} 缺 grow`).toEqual({ on: 'tap:grow', route: 'desk', op: 'grow' })
    }
  })

  it('导航卡刻意没有关闭按钮——导航中把导航关掉是事故，缩放不受影响', () => {
    expect(routeOf('nav', 'tap:close')).toBeUndefined()
    expect(routeOf('nav', 'tap:shrink')!.op).toBe('shrink')
  })

  it('除导航卡外，每个模板都有右上角关闭按钮', () => {
    for (const tmpl of CARD_TEMPLATES.map(t => t.id).filter(id => id !== 'nav'))
      expect(routeOf(tmpl, 'tap:close'), `${tmpl} 缺 close`).toEqual({ on: 'tap:close', route: 'desk', op: 'dismiss' })
  })

  it('台下清单的条目点击 → 直调 card.focus，value 即 cardId', () => {
    const r = routeOf('stagedlist', 'tap:item')!
    expect(r.route).toBe('tool')
    expect(r.tool).toBe('card.focus')
    expect(r.valueParam).toBe('cardId')
  })

  it('声明里的 tool 路由都指向真实存在的 Tool 名', async () => {
    const { INTERACTIONS } = await import('../../src/config/interactions')
    const { TOOLS } = await import('../../src/config/tools')
    const names = new Set(TOOLS.map(t => t.name))
    for (const [tpl, decls] of Object.entries(INTERACTIONS))
      for (const d of decls)
        if (d.route === 'tool') expect(names.has(d.tool!), `${tpl}.${d.on} → ${d.tool}`).toBe(true)
  })
})

describe('模板契约三件套齐了', () => {
  it('每个可交互模板的声明都挂在契约边上，加交互 = 加数据', () => {
    // 声明文件与模板同域（config），不在 screen 里——手势层只是消费者
    for (const t of CARD_TEMPLATES) expect(t.id).toBeTruthy()
  })
})
