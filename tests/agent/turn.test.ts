import { describe, it, expect } from 'vitest'
import { createTurn } from '../../src/agent/turn'

/**
 * Turn = 一个 run() 的回合状态（R-1，调度与呈现重构方案 §02）。
 * 从 pipeline.ts 的模块级 let 里搬出来的第一批：撞墙检测（lastFailSig/failStreak）
 * 与打转熔断（prevOk）。以前这两块是模块级共享状态，subRun 的后台工具调用
 * 和主 turn 共用同一份——子 Agent 撞墙会污染主 turn 的撞墙计数。
 * Turn 每次 run()/subRun() 各建一份，天然隔离。
 */

describe('createTurn：撞墙检测', () => {
  it('同一失败签名连续 3 次才算撞墙', () => {
    const turn = createTurn()
    expect(turn.hitWall()).toBe(false)
    turn.noteFailSig('a.b|CODE', false)
    expect(turn.hitWall()).toBe(false)
    turn.noteFailSig('a.b|CODE', false)
    expect(turn.hitWall()).toBe(false)
    turn.noteFailSig('a.b|CODE', false)
    expect(turn.hitWall()).toBe(true)
  })

  it('换了失败签名就重新计数', () => {
    const turn = createTurn()
    turn.noteFailSig('a.b|CODE', false)
    turn.noteFailSig('a.b|CODE', false)
    turn.noteFailSig('c.d|OTHER', false)
    expect(turn.hitWall()).toBe(false)
    turn.noteFailSig('c.d|OTHER', false)
    turn.noteFailSig('c.d|OTHER', false)
    expect(turn.hitWall()).toBe(true)
  })

  it('空签名（本轮全 ok）清零撞墙计数', () => {
    const turn = createTurn()
    turn.noteFailSig('a.b|CODE', false)
    turn.noteFailSig('a.b|CODE', false)
    turn.noteFailSig('', false)
    turn.noteFailSig('a.b|CODE', false)
    expect(turn.hitWall()).toBe(false)
  })

  it('元工具轮（metaOnly）不清洗撞墙计数（load/skill 是准备动作不是进展）', () => {
    const turn = createTurn()
    turn.noteFailSig('a.b|CODE', false)
    turn.noteFailSig('a.b|CODE', false)
    turn.noteFailSig('', true)   // 元工具轮全 ok，metaOnly=true，不该清零
    turn.noteFailSig('a.b|CODE', false)
    expect(turn.hitWall()).toBe(true)
  })
})

describe('createTurn：REPEAT_CALL 打转熔断', () => {
  it('lane 上一轮记过的签名，本轮判定为已 ok', () => {
    const turn = createTurn()
    expect(turn.wasJustOk('fast', 'voice.speak|{}')).toBe(false)
    turn.recordLane('fast', ['voice.speak|{}'])
    expect(turn.wasJustOk('fast', 'voice.speak|{}')).toBe(true)
  })

  it('lane 之间互相隔离', () => {
    const turn = createTurn()
    turn.recordLane('fast', ['a|{}'])
    expect(turn.wasJustOk('slow', 'a|{}')).toBe(false)
  })

  it('recordLane 覆盖上一轮记录（不是累加）：换了参数就不再命中旧签名', () => {
    const turn = createTurn()
    turn.recordLane('fast', ['a|{"x":1}'])
    turn.recordLane('fast', ['a|{"x":2}'])
    expect(turn.wasJustOk('fast', 'a|{"x":1}')).toBe(false)
    expect(turn.wasJustOk('fast', 'a|{"x":2}')).toBe(true)
  })
})

describe('createTurn：多实例互相隔离（子 Agent 不该污染主 turn）', () => {
  it('两个独立 Turn 各自的撞墙计数互不影响', () => {
    const main = createTurn()
    const sub = createTurn()
    sub.noteFailSig('sub.tool|ERR', false)
    sub.noteFailSig('sub.tool|ERR', false)
    sub.noteFailSig('sub.tool|ERR', false)
    expect(sub.hitWall()).toBe(true)
    expect(main.hitWall()).toBe(false)
  })

  it('两个独立 Turn 的打转熔断表互不影响', () => {
    const main = createTurn()
    const sub = createTurn()
    sub.recordLane('fast', ['x|{}'])
    expect(main.wasJustOk('fast', 'x|{}')).toBe(false)
  })
})
