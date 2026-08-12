import { describe, it, expect } from 'vitest'
import { SANDBOX, buildSrcdoc, validateBridgeMsg } from '../../src/screen/canvasApp'
import { healStep } from '../../src/cards/heal'
import { pixelsOf } from '../../src/config/grid'

/**
 * canvas-app：全系统**唯一的容器**（公理 1 的逃生舱）。
 * 模型的 JS 在 iframe 沙箱里执行——这是把模型输出当代码执行的第二处，
 * 安全铁律必须有测试锁死，不是注释里的善意。
 */
describe('安全三铁律', () => {
  it('① sandbox 只有 allow-scripts，绝不含 allow-same-origin', () => {
    expect(SANDBOX).toBe('allow-scripts')
    // 加了 allow-same-origin，sandbox 等于没开：模型代码直接读走
    // localStorage 里的 OpenRouter/高德 Key
    expect(SANDBOX).not.toContain('allow-same-origin')
    expect(SANDBOX).not.toContain('allow-top-navigation')
    expect(SANDBOX).not.toContain('allow-forms')
  })

  it('② srcdoc 注入 CSP：模型代码不得外呼网络', () => {
    const doc = buildSrcdoc('<p>hi</p>')
    expect(doc).toContain('Content-Security-Policy')
    expect(doc).toContain("default-src 'none'")
    // 但内联样式和脚本要放行——不然它什么都画不了
    expect(doc).toMatch(/style-src[^;"]*'unsafe-inline'/)
    expect(doc).toMatch(/script-src[^;"]*'unsafe-inline'/)
  })

  it('②b 内嵌图片放行（data:）——图表常用，且不产生网络请求', () => {
    expect(buildSrcdoc('<p>x</p>')).toMatch(/img-src[^;"]*data:/)
  })

  it('③ 模型的 html 原样进容器（沙箱内不消毒——隔离才是这里的边界）', () => {
    const doc = buildSrcdoc('<script>draw()</script><div id="app"></div>')
    expect(doc).toContain('<script>draw()</script>')
  })

  it('桥的辅助函数注入：cockpit.action / 自动上报高度', () => {
    const doc = buildSrcdoc('<p>x</p>')
    expect(doc).toContain('cockpit')
    expect(doc).toContain("postMessage")
    expect(doc).toContain('height')
  })
})

/**
 * postMessage 桥只认两个形状——桥上进来的一律当**不可信数据**。
 * 模型代码能 post 任意东西，形状校验是宿主侧的责任。
 */
describe('桥消息校验', () => {
  it('height：要有限正数', () => {
    expect(validateBridgeMsg({ type: 'height', px: 420 })).toEqual({ type: 'height', px: 420 })
    expect(validateBridgeMsg({ type: 'height', px: -1 })).toBeNull()
    expect(validateBridgeMsg({ type: 'height', px: Infinity })).toBeNull()
    expect(validateBridgeMsg({ type: 'height', px: '420' })).toBeNull()
  })

  it('action：字符串且封顶 200 字——别让沙箱借桥灌提示注入', () => {
    expect(validateBridgeMsg({ type: 'action', value: '选了方案A' })).toEqual({ type: 'action', value: '选了方案A' })
    expect(validateBridgeMsg({ type: 'action', value: 'x'.repeat(201) })).toBeNull()
    expect(validateBridgeMsg({ type: 'action', value: 42 })).toBeNull()
  })

  it('别的形状一律拒收', () => {
    expect(validateBridgeMsg({ type: 'eval', code: 'x' })).toBeNull()
    expect(validateBridgeMsg(null)).toBeNull()
    expect(validateBridgeMsg('height')).toBeNull()
  })
})

/**
 * 动态尺寸 = 溢出自愈闭环。屏幕量出内容高度上报，director 机制层决定升降档：
 * 溢出升一档（≤2 次防振荡），内容不足六成缩一档。sizeLocked 例外——
 * 用户缩小过的卡宁可折角提示，意愿 > 建议。
 */
describe('healStep：升降档决策（机制，零模型）', () => {
  const h = (size: string) => pixelsOf(size).h

  it('内容超出画布 → 升一档（第一步加宽，文字回流后高度自然缩）', () => {
    expect(healStep('1/6', h('1/6') + 100, { bumps: 0 })).toBe('wide')
  })

  it('tower 不进自愈阶梯——1/2 的下一步不能是宽度砍半的竖条', () => {
    expect(healStep('1/2', h('1/2') + 100, { bumps: 0 })).toBe('2/3')
  })

  it('升到白名单顶就不再升', () => {
    expect(healStep('full', h('full') + 100, { bumps: 0 })).toBeNull()
  })

  it('两次之后不再折腾——防振荡', () => {
    expect(healStep('1/6', h('1/6') + 100, { bumps: 2 })).toBeNull()
  })

  it('内容不足画布六成 → 缩一档还位给桌面', () => {
    expect(healStep('1/2', h('1/2') * 0.3, { bumps: 0 })).toBe('1/3')
  })

  it('内容量正常 → 不动', () => {
    expect(healStep('1/3', h('1/3') * 0.8, { bumps: 0 })).toBeNull()
  })

  it('sizeLocked 的卡不自动动——意愿大于建议', () => {
    expect(healStep('1/6', h('1/6') + 100, { bumps: 0, sizeLocked: true })).toBeNull()
  })
})
