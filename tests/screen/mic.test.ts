import { describe, it, expect } from 'vitest'
import { micAct, PRIORITY } from '../../src/screen/mic'

/**
 * 麦克风仲裁（语音链路设计 §1）：全系统一个"麦克风"，谁想出声先过裁判。
 * 决策是纯函数，执行是屏端薄层。优先级：confirm > turn > story > delivery。
 */
describe('micAct 优先级矩阵', () => {
  it('空麦直接说', () => {
    expect(micAct('turn', null)).toBe('speak')
    expect(micAct('story', null)).toBe('speak')
  })
  it('确认问句打断绘本和普通话术——安全类问题不排在故事后面', () => {
    expect(micAct('confirm', 'story')).toBe('interrupt')
    expect(micAct('confirm', 'turn')).toBe('interrupt')
  })
  it('普通话术遇上绘本 → 丢弃：衔接话术过期即无意义，不排队', () => {
    expect(micAct('turn', 'story')).toBe('drop')
  })
  it('后台交付永远排队，不打断任何人', () => {
    expect(micAct('delivery', 'turn')).toBe('queue')
    expect(micAct('delivery', 'story')).toBe('queue')
    expect(micAct('delivery', 'confirm')).toBe('queue')
  })
  it('同源排队（turn 的同轮排队语义保持）', () => {
    expect(micAct('turn', 'turn')).toBe('queue')
  })
  it('turn 遇上 confirm 排队——确认话音刚落就接上', () => {
    expect(micAct('turn', 'confirm')).toBe('queue')
  })
  it('优先级表数字越小越高', () => {
    expect(PRIORITY.confirm).toBeLessThan(PRIORITY.turn)
    expect(PRIORITY.turn).toBeLessThan(PRIORITY.story)
    expect(PRIORITY.story).toBeLessThan(PRIORITY.delivery)
  })
})
