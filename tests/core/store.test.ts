import { describe, it, expect, vi } from 'vitest'
import { createStore } from '../../src/core/store'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'

const newStore = () => createStore(SIGNALS, CONSTRAINTS)

/* ────────────────────────────── 信号注册表 ────────────────────────────── */
describe('信号注册表', () => {
  it('已注册信号可读，初始值为 config 定义的 initial', () => {
    const s = newStore()
    expect(s.get('cabin.window.driver.position')).toBe(0)
    expect(s.get('vehicle.speed')).toBe(0)
  })

  it('未注册路径返回 unavailable，不抛异常', () => {
    const s = newStore()
    expect(s.get('cabin.window.nonexistent.position')).toBeUndefined()
    const r = s.set('cabin.does.not.exist', 1)
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('UNKNOWN_SIGNAL')
  })

  it('未选装的信号返回 unavailable / NOT_EQUIPPED —— 反幻觉的底层保障', () => {
    const s = newStore()
    const r = s.set('cabin.sunroof.glass.position', 100)
    expect(r.status).toBe('unavailable')
    expect(r.code).toBe('NOT_EQUIPPED')
    expect(r.message).toContain('未配备')
  })

  it('每个信号都必须声明 vssPath（构建期契约）', () => {
    for (const sig of SIGNALS) {
      expect(sig.vssPath, `${sig.alias} 缺少 vssPath`).toBeTruthy()
    }
  })
})

/* ────────────────────────────── 读写与 Access ────────────────────────────── */
describe('读写与 Access', () => {
  it('READ_WRITE 信号可写', () => {
    const s = newStore()
    const r = s.set('cabin.window.driver.position', 60)
    expect(r.status).toBe('ok')
    expect(s.getTarget('cabin.window.driver.position')).toBe(60)
  })

  it('READ 信号不可写，返回 rejected / READ_ONLY', () => {
    const s = newStore()
    const r = s.set('vehicle.speed', 80)
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('READ_ONLY')
  })

  it('仿真通道 setDirect 可以绕过 access 写只读信号（供控制面板使用）', () => {
    const s = newStore()
    s.setDirect('vehicle.speed', 120)
    expect(s.get('vehicle.speed')).toBe(120)
  })

  it('超出 range 返回 OUT_OF_RANGE', () => {
    const s = newStore()
    expect(s.set('cabin.window.driver.position', 140).code).toBe('OUT_OF_RANGE')
    expect(s.set('cabin.window.driver.position', -5).code).toBe('OUT_OF_RANGE')
  })

  it('ok 结果携带 changed 路径列表', () => {
    const s = newStore()
    const r = s.set('cabin.window.driver.position', 50)
    expect(r.changed).toEqual(['cabin.window.driver.position'])
  })
})

/* ────────────────────────────── 订阅 ────────────────────────────── */
describe('订阅', () => {
  it('值变化时触发订阅回调', () => {
    const s = newStore()
    const cb = vi.fn()
    s.subscribe('cabin.childLock', cb)
    s.set('cabin.childLock', true)
    expect(cb).toHaveBeenCalledWith('cabin.childLock', true)
  })

  it('值未变化时不触发', () => {
    const s = newStore()
    const cb = vi.fn()
    s.subscribe('cabin.childLock', cb)
    s.set('cabin.childLock', false)
    expect(cb).not.toHaveBeenCalled()
  })

  it('支持通配订阅', () => {
    const s = newStore()
    const cb = vi.fn()
    s.subscribe('cabin.window.*.position', cb)
    s.set('cabin.window.rearLeft.position', 30)
    expect(cb).toHaveBeenCalled()
  })

  it('取消订阅后不再触发', () => {
    const s = newStore()
    const cb = vi.fn()
    const off = s.subscribe('cabin.childLock', cb)
    off()
    s.set('cabin.childLock', true)
    expect(cb).not.toHaveBeenCalled()
  })
})

/* ────────────────────────────── 过渡仿真 ────────────────────────────── */
describe('过渡仿真', () => {
  it('set 只改 target，current 需要时间逼近', () => {
    const s = newStore()
    s.set('cabin.window.driver.position', 100)
    expect(s.getTarget('cabin.window.driver.position')).toBe(100)
    expect(s.get('cabin.window.driver.position')).toBe(0)
  })

  it('tick 推进后 current 按 transition 时长匀速逼近', () => {
    const s = newStore()
    s.set('cabin.window.driver.position', 100)
    s.tick(2000) // 全行程 4000ms，走一半
    expect(s.get('cabin.window.driver.position')).toBeCloseTo(50, 0)
  })

  it('tick 足够久后精确到达 target，不过冲', () => {
    const s = newStore()
    s.set('cabin.window.driver.position', 100)
    s.tick(9999)
    expect(s.get('cabin.window.driver.position')).toBe(100)
  })

  it('过渡中改向：从当前中间态反向，不跳变（Golden Case 5）', () => {
    const s = newStore()
    s.set('cabin.window.driver.position', 100)
    s.tick(1600)
    const mid = s.get('cabin.window.driver.position') as number
    expect(mid).toBeGreaterThan(30)
    expect(mid).toBeLessThan(50)

    s.set('cabin.window.driver.position', 0)
    expect(s.get('cabin.window.driver.position')).toBe(mid) // 不跳变
    s.tick(400)
    const after = s.get('cabin.window.driver.position') as number
    expect(after).toBeLessThan(mid)   // 已在反向
    expect(after).toBeGreaterThan(0)
  })

  it('无 transition 的信号立即到位', () => {
    const s = newStore()
    s.set('cabin.childLock', true)
    expect(s.get('cabin.childLock')).toBe(true)
  })
})

/* ────────────────────────────── 约束引擎 ────────────────────────────── */
describe('约束引擎', () => {
  it('SPEED_LIMITED：高速时车窗限位到 30，仍返回 ok 但带 code 与 message', () => {
    const s = newStore()
    s.setDirect('vehicle.speed', 120)
    const r = s.set('cabin.window.driver.position', 100)
    expect(r.status).toBe('ok')
    expect(r.code).toBe('SPEED_LIMITED')
    expect(r.applied).toBe(30)
    expect(r.message).toContain('120')      // 模板变量已插值
    expect(s.getTarget('cabin.window.driver.position')).toBe(30)
  })

  it('SPEED_LIMITED：请求值本就低于限位时不触发', () => {
    const s = newStore()
    s.setDirect('vehicle.speed', 120)
    const r = s.set('cabin.window.driver.position', 20)
    expect(r.code).toBeUndefined()
    expect(r.applied).toBe(20)
  })

  it('CHILD_LOCK_ON：儿童锁开启时后窗被拒，且带 suggestion（Golden Case 8）', () => {
    const s = newStore()
    s.set('cabin.childLock', true)
    const r = s.set('cabin.window.rearLeft.position', 100)
    expect(r.status).toBe('rejected')
    expect(r.code).toBe('CHILD_LOCK_ON')
    expect(r.suggestion).toBeTruthy()
    expect(s.getTarget('cabin.window.rearLeft.position')).toBe(0) // 未生效
  })

  it('CHILD_LOCK_ON：只作用于后窗，前窗不受影响（通配匹配正确）', () => {
    const s = newStore()
    s.set('cabin.childLock', true)
    expect(s.set('cabin.window.driver.position', 100).status).toBe('ok')
  })

  it('message 支持 {path} 与 {value} 模板插值', () => {
    const s = newStore()
    s.setDirect('vehicle.speed', 110)
    const r = s.set('cabin.window.driver.position', 100)
    expect(r.message).toBe('当前车速 110km/h，车窗最多开到 30%')
  })
})

/* ────────────────────────────── 状态不变量 ────────────────────────────── */
describe('状态不变量断言', () => {
  it('正常状态下无违规', () => {
    const s = newStore()
    expect(s.checkInvariants()).toEqual([])
  })

  it('所有 position 必须在 [0,100] —— 用 setDirect 制造违规能被抓到', () => {
    const s = newStore()
    s.setDirect('cabin.window.driver.position', 150)
    const v = s.checkInvariants()
    expect(v.length).toBeGreaterThan(0)
    expect(v[0]).toContain('cabin.window.driver.position')
  })

  it('行驶中不允许车门开启', () => {
    const s = newStore()
    s.setDirect('vehicle.speed', 60)
    s.setDirect('cabin.door.driver.isOpen', true)
    expect(s.checkInvariants().join()).toContain('行驶中')
  })
})

/* ────────────────────────────── 快照与上下文 ────────────────────────────── */
describe('快照', () => {
  it('snapshot 返回全部 current 值', () => {
    const s = newStore()
    const snap = s.snapshot()
    expect(snap['vehicle.speed']).toBe(0)
    expect(Object.keys(snap).length).toBe(SIGNALS.length)
  })

  it('CONTINUOUS 信号在摘要中被标记，供上下文注入裁剪', () => {
    const s = newStore()
    const sig = SIGNALS.find(x => x.alias === 'vehicle.speed')!
    expect(sig.changeMode).toBe('CONTINUOUS')
  })
})

/**
 * ══════════ setMany：播放态六连写的事务通知（2026-08-19 实拍）══════════
 * 音乐→视频：videoPlay 六条信号逐条 set，第一条 source='video' 落下时
 * streamUrl 还是音乐的——这个中间态快照被推到车机屏，视频卡拿着音乐 URL
 * 开播了一段。修法：**先全写后通知**——订阅者收到第一个通知时，
 * 读到的已是完整终态。部分非法则全不写（"部分提交"是被测试抓过的老 bug）。
 */
describe('setMany', () => {
  it('订阅者在第一个通知回调里读到的就是终态——没有中间态窗口', () => {
    const s = createStore(SIGNALS, CONSTRAINTS)
    s.setDirect('media.source', 'music')
    s.setDirect('media.streamUrl', 'https://old/music.mp3')
    const seen: Array<{ source: unknown; url: unknown }> = []
    s.subscribe('media.*', () => seen.push({ source: s.get('media.source'), url: s.get('media.streamUrl') }))
    const r = s.setMany([
      ['media.source', 'video'],
      ['media.streamUrl', 'https://new/video.mp4'],
      ['media.playing', true],
    ])
    expect(r.status).toBe('ok')
    expect(seen.length).toBeGreaterThan(0)
    for (const snap of seen) {
      expect(snap.source, '任何一次通知里都不许出现旧 source').toBe('video')
      expect(snap.url, '任何一次通知里都不许出现旧 url').toBe('https://new/video.mp4')
    }
  })

  it('任何一条非法则全不写（先验后写，无部分提交）', () => {
    const s = createStore(SIGNALS, CONSTRAINTS)
    s.setDirect('media.source', 'music')
    const r = s.setMany([
      ['media.source', 'video'],
      ['media.volume', 9999],   // 超范围
    ])
    expect(r.status).not.toBe('ok')
    expect(s.get('media.source'), '第一条也不许落地').toBe('music')
  })

  it('值没变的键不通知（有净变化才通知）', () => {
    const s = createStore(SIGNALS, CONSTRAINTS)
    s.setDirect('media.source', 'music')
    let n = 0
    s.subscribe('media.source', () => n++)
    s.setMany([['media.source', 'music']])
    expect(n).toBe(0)
  })
})
