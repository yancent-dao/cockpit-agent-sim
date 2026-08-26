import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { buildSystemPrompt, buildStateNote } from '../../src/agent/context'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'
import { MAIN_AGENT } from '../../agents/main-agent/manifest'

/**
 * 上下文注入（原 runtime.test 迁来——旧单层 runtime 已被 pipeline 取代删除，
 * 这些断言校的是 buildSystemPrompt，与循环无关，全部保留）
 */

let store: ReturnType<typeof createStore>
let reg: ReturnType<typeof createRegistry>
beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  reg = createRegistry(store, TOOLS)
})

/** 三层化后内容分两处（稳定 system + 易变 stateNote）。这里断言"注入了什么"，
 *  合并看；"落在哪一层"由 pipeline.test 的三层化测试盯 */
const full = (extras: any = {}) =>
  buildSystemPrompt(MAIN_AGENT, store, reg, extras) + '\n' + buildStateNote(MAIN_AGENT, store, extras)

/* ────────────────────────── 上下文注入 ────────────────────────── */
describe('上下文注入', () => {
  it('包含车辆状态快照', () => {
    store.setDirect('vehicle.speed', 60)
    const p = full()
    expect(p).toContain('车辆状态')
    expect(p).toContain('60')
  })

  it('包含说话人位置，用于指代消解（Golden Case 4）', () => {
    store.setDirect('perception.voiceSource', 'rearLeft')
    expect(full()).toContain('左后')
  })

  // 裸英文枚举值（"香型: none"）逼着模型自己现编中文说法，实测编出了枚举里
  // 根本没有的"清香"。中文名是数据，跟着信号定义走
  it('枚举值按信号自带的中文标签注入', () => {
    const p = full()
    expect(p).toContain('香型: 无')
    expect(p).not.toContain('香型: none')
  })

  it('没配中文标签的枚举值原样注入', () => {
    store.setDirect('vehicle.carType', 'ev')
    expect(full()).toContain('ev')
  })

  it('CONTINUOUS 信号取整注入，不带无意义小数', () => {
    store.setDirect('vehicle.speed', 62.4718)
    const p = full()
    expect(p).toContain('62')
    expect(p).not.toContain('62.4718')
  })

  it('未选装能力在提示里被显式标注，降低幻觉概率', () => {
    const p = full()
    expect(p).toContain('未配备')
    expect(p).toContain('全景天窗')
  })

  it('绝不泄露「黑」级能力', () => {
    expect(full()).not.toContain('brake.apply')
  })

  it('注入桌面布局摘要 —— 无APP化下 Agent 必须知道屏幕上有什么', () => {
    const p = full({ desktop: 'Agent 区：车窗(1/6)，剩余 2 格' })
    expect(p).toContain('桌面布局')
    expect(p).toContain('剩余 2 格')
  })

  it('未提供桌面摘要时不注入空段落', () => {
    expect(full()).not.toContain('桌面布局')
  })

  it('人设 ≤ 22 行（v1.0 约定：主 Agent 是测试探针不是产品）', () => {
    expect(MAIN_AGENT.persona.trim().split('\n').length).toBeLessThanOrEqual(22)
  })
})
