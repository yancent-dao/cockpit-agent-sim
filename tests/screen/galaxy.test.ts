import { describe, it, expect } from 'vitest'
import { galaxyParams } from '../../src/screen/galaxy'

/**
 * C3a 星河盘：状态 → 视觉参数的映射是纯函数（渲染循环在车机屏，测不了；
 * "什么状态长什么样"是设计定稿的规范，判断错一次就是"确认态还在转、
 * 用户不知道系统在等他"这类实拍问题）。
 *
 * 状态名对齐 pipeline/voice 总线既有词汇：idle/wakeup/listening/thinking/
 * speaking/executing/confirming/rejected。
 */

describe('galaxyParams：八态各有其形', () => {
  it('待机最暗最慢——余光里不打扰', () => {
    const p = galaxyParams('idle')
    expect(p.alpha).toBeLessThan(galaxyParams('speaking').alpha)
    expect(p.speed).toBeLessThan(galaxyParams('listening').speed)
  })

  it('思考转得最快——十几秒的等待要看得出"在干活"', () => {
    const think = galaxyParams('thinking').speed
    for (const s of ['idle', 'listening', 'speaking', 'confirming'])
      expect(think).toBeGreaterThan(galaxyParams(s).speed)
  })

  it('聆听星盘收拢（gather < 1）——"我在听你说"', () => {
    expect(galaxyParams('listening').gather).toBeLessThan(1)
    expect(galaxyParams('idle').gather).toBe(1)
  })

  it('播报有径向声浪，其它状态没有', () => {
    expect(galaxyParams('speaking').wave).toBe(true)
    expect(galaxyParams('thinking').wave).toBe(false)
    expect(galaxyParams('idle').wave).toBe(false)
  })

  it('待确认：停转 + 琥珀——颜色和静止一起说"轮到你了"', () => {
    const p = galaxyParams('confirming')
    expect(p.speed).toBe(0)
    expect(p.amber).toBe(true)
  })

  it('拒绝/出错也走琥珀，但不停转（不是在等回答）', () => {
    const p = galaxyParams('rejected')
    expect(p.amber).toBe(true)
    expect(p.speed).toBeGreaterThan(0)
  })

  it('执行态核心闪烁——每闪一下对应一次工具落地', () => {
    expect(galaxyParams('executing').flash).toBe(true)
    expect(galaxyParams('speaking').flash).toBe(false)
  })

  it('未知状态回退到待机参数，不炸', () => {
    expect(galaxyParams('nonsense')).toEqual(galaxyParams('idle'))
  })
})
