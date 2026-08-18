import { describe, it, expect } from 'vitest'
import { BASE_CSS, LIGHT_CSS, DARK_CSS, TIER_UNITS, tokensFor } from '../../src/design/tokens'
import { tierNames } from '../../src/config/grid'

/** 从 CSS 文本里抓某个自定义属性的值 */
const varOf = (css: string, name: string) =>
  css.match(new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;}]+)`))?.[1]?.trim()

describe('token 是 CSS 文本常量，不是外部样式表', () => {
  /**
   * build-single.mjs 只替换 <script type="module">，外部 .css 在单文件版会整个丢失。
   * 所以 token 必须以字符串形式活在 JS 里，运行时注入 <style>。
   */
  it('导出的是字符串，能被 esbuild 打进 iife', () => {
    expect(typeof BASE_CSS).toBe('string')
    expect(typeof LIGHT_CSS).toBe('string')
    expect(typeof DARK_CSS).toBe('string')
    expect(BASE_CSS.length).toBeGreaterThan(200)
  })

  it('大括号配对，不会注入出语法错误的样式表', () => {
    for (const [n, css] of [['base', BASE_CSS], ['light', LIGHT_CSS], ['dark', DARK_CSS]] as const) {
      const open = (css.match(/{/g) ?? []).length
      const close = (css.match(/}/g) ?? []).length
      expect(open, `${n} 的大括号`).toBe(close)
      expect(open, `${n} 至少要有一个规则块`).toBeGreaterThan(0)
    }
  })
})

describe('字阶：7 阶，一次性解决 23 个散装字号', () => {
  const STEPS = ['--t-cap', '--t-body', '--t-title', '--t-lead', '--t-num', '--t-hero', '--t-mega']

  it('7 阶齐全且都是 px', () => {
    for (const s of STEPS) {
      const v = varOf(BASE_CSS, s)
      expect(v, s).toBeTruthy()
      expect(v, s).toMatch(/^\d+px$/)
    }
  })

  it('从小到大严格递增——不递增的字阶等于没有字阶', () => {
    const nums = STEPS.map(s => parseInt(varOf(BASE_CSS, s)!, 10))
    for (let i = 1; i < nums.length; i++)
      if (STEPS[i] !== '--t-title')   // title 刻意比 body 小：标题让位给数值
        expect(nums[i], `${STEPS[i]} 应大于前一阶`).toBeGreaterThanOrEqual(nums[i - 1])
  })

  // 设计语言第 3 条：标题降级、数字是主角
  it('标题阶比正文阶小 —— 标题要让位给数值', () => {
    expect(parseInt(varOf(BASE_CSS, '--t-title')!, 10))
      .toBeLessThan(parseInt(varOf(BASE_CSS, '--t-body')!, 10))
  })
})

describe('形状单位 --u：14 个形状全覆盖', () => {
  // 从 grid 派生，不手抄 —— 手抄的表在 12×8 迁移时整个失效而测试还"通过"
  const TIERS = tierNames()

  it('每档都有 --u', () => {
    for (const t of TIERS) expect(TIER_UNITS[t], t).toBeGreaterThan(0)
  })

  it('box 是基准形状，--u 正好是 1', () => {
    expect(TIER_UNITS.box).toBe(1)
  })

  // 字号 = 字阶 × --u。档位越大字越大，这是"自适应尺寸"不再靠 CSS 硬怼的根据
  it('越大的档位 --u 越大', () => {
    expect(TIER_UNITS.chip).toBeLessThan(TIER_UNITS.box)
    expect(TIER_UNITS.box).toBeLessThan(TIER_UNITS.panel)
    expect(TIER_UNITS.panel).toBeLessThan(TIER_UNITS.stage)
    expect(TIER_UNITS.stage).toBeLessThan(TIER_UNITS.full)
  })

  it('CSS 里每档都生成了对应的类', () => {
    for (const t of TIERS) expect(BASE_CSS, t).toContain(`.t-${t}`)
  })
})

describe('语义色：八类各四件套', () => {
  const KINDS = ['brand', 'info', 'ok', 'warn', 'danger', 'media', 'pick', 'sys']

  /**
   * 诊断 5：现在系统卡描边、提示底色、拒绝横幅全是 warning 橙，
   * 用户分不出「系统卡」「提示」「拒绝」。八类各自成套才能拆开。
   */
  it('八类 × fg/bg/bd/gr 全都定义了', () => {
    for (const k of KINDS)
      for (const part of ['fg', 'bg', 'bd', 'gr'])
        expect(varOf(LIGHT_CSS, `--${k}-${part}`), `--${k}-${part}`).toBeTruthy()
  })

  it('拒绝用 danger、约束不满足用 warn，两者不是同一个色', () => {
    expect(varOf(LIGHT_CSS, '--danger-fg')).not.toBe(varOf(LIGHT_CSS, '--warn-fg'))
  })

  it('选择用 pick、导航用 brand，序号圆点才不会跟转向条抢戏', () => {
    expect(varOf(LIGHT_CSS, '--pick-fg')).not.toBe(varOf(LIGHT_CSS, '--brand-fg'))
  })

  it('深色映射同样八类齐全 —— 控制面板共用字阶但颜色走深色', () => {
    for (const k of KINDS) expect(varOf(DARK_CSS, `--${k}-fg`), `dark --${k}-fg`).toBeTruthy()
  })
})

describe('tokensFor：按场景拼样式表', () => {
  it('车机屏拿到基础层 + 浅色语义', () => {
    const css = tokensFor('screen')
    expect(css).toContain('--t-mega')
    expect(css).toContain(varOf(LIGHT_CSS, '--sf-card')!)
  })

  it('控制面板拿到基础层 + 深色语义', () => {
    const css = tokensFor('director')
    expect(css).toContain('--t-mega')          // 字阶共用
    expect(css).toContain(varOf(DARK_CSS, '--sf-card')!)
  })

  it('两个场景的字阶完全一致 —— 共用的是排版不是配色', () => {
    const g = (css: string) => css.match(/--t-[a-z]+\s*:\s*\d+px/g)?.sort()
    expect(g(tokensFor('screen'))).toEqual(g(tokensFor('director')))
  })
})

describe('数字排版', () => {
  // ETA 从 28 跳到 27 时会左右抖，现在只加了 6 处
  it('提供等宽数字的工具类', () => {
    expect(BASE_CSS).toContain('tabular-nums')
  })

  // 车机上远看发虚，字重收到 400/500/600/700 四档
  it('没有 300 这种细字重', () => {
    expect(BASE_CSS).not.toMatch(/font-weight\s*:\s*300/)
    expect(LIGHT_CSS).not.toMatch(/font-weight\s*:\s*300/)
  })
})

/**
 * 壁纸与主题（2026-08-18 解禁）。决策是纯函数：遮罩是可读性底线。
 */
import { wallpaperCss } from '../../src/design/tokens'

describe('壁纸层', () => {
  it('预设走渐变，自定义走图，都压一层遮罩', () => {
    expect(wallpaperCss('preset:dusk', 'day')).toContain('linear-gradient(rgba(231')
    expect(wallpaperCss('custom:x', 'day', 'data:image/webp;base64,AA')).toContain('url(data:image/webp')
  })
  it('夜间遮罩换深色', () => {
    expect(wallpaperCss('preset:aurora', 'night')).toContain('rgba(11,15,22')
  })
  it('空值/查无预设/自定义无图 → 空串（恢复默认底）', () => {
    expect(wallpaperCss('', 'day')).toBe('')
    expect(wallpaperCss('preset:ghost', 'day')).toBe('')
    expect(wallpaperCss('custom:x', 'day', null)).toBe('')
  })
})

describe('主题 token', () => {
  it('车机屏夜间复用 DARK 语义层', () => {
    expect(tokensFor('screen', 'night')).toContain('--sf-base:#0')
    expect(tokensFor('screen', 'day')).not.toContain('--sf-base:#0B0F16')
  })
})
