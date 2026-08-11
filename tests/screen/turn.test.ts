import { describe, it, expect } from 'vitest'
import { parseTurn, dayLabel } from '../../src/screen/turn'

/**
 * 高德的 instruction 是一整句话："沿人民南路四段向南行驶1.2公里后右转进入机场高速"。
 * 转向条要拆成三块：还有多远 · 做什么动作 · 上哪条路。
 * 第一版把路名当噪音删掉了，只剩"后右转"——"后"是切割残渣，而路名恰恰是
 * 用户确认自己没走错的唯一依据。
 */
describe('转向条文案解析', () => {
  it('拆出距离、动作、要进的路', () => {
    expect(parseTurn('沿人民南路四段向南行驶1.2公里后右转进入机场高速')).toEqual({
      dist: '1.2公里', action: '右转', road: '机场高速', icon: '↱',
    })
  })

  it('米也认', () => {
    const t = parseTurn('沿蜀都大道行驶300米后左转进入红星路二段')
    expect(t.dist).toBe('300米')
    expect(t.action).toBe('左转')
    expect(t.road).toBe('红星路二段')
  })

  it('没有"进入XX"时路名留空，不硬凑', () => {
    const t = parseTurn('行驶800米后靠右')
    expect(t.dist).toBe('800米')
    expect(t.action).toBe('靠右')
    expect(t.road).toBe('')
  })

  it('到达终点没有距离也不该崩', () => {
    const t = parseTurn('到达目的地')
    expect(t.action).toBe('到达目的地')
    expect(t.icon).toBe('◎')
    expect(t.dist).toBe('')
  })

  it('识别掉头与环岛', () => {
    expect(parseTurn('行驶100米后掉头').icon).toBe('⤺')
    expect(parseTurn('进入环岛，从第二个出口驶出').icon).toBe('⟳')
  })

  it('动作里绝不留"后"这种切割残渣', () => {
    for (const s of [
      '沿人民南路四段向南行驶1.2公里后右转进入机场高速',
      '行驶800米后靠右',
      '沿机场高速行驶14公里后到达终点',
    ]) expect(parseTurn(s).action).not.toMatch(/^后/)
  })

  it('认不出格式时整句兜底，不出空白条', () => {
    expect(parseTurn('前方施工绕行').action).toBe('前方施工绕行')
  })
})

/** 车机上没人读"2026-08-11"，天气预报的日期要说人话 */
describe('预报日期人性化', () => {
  // 用本地时间构造，别带时区偏移——否则跑测试的机器在哪个时区，"今天"就是哪天
  const today = new Date(2026, 7, 11, 9)   // 2026-08-11 周二
  it('今天明天后天直接说', () => {
    expect(dayLabel('2026-08-11', today)).toBe('今天')
    expect(dayLabel('2026-08-12', today)).toBe('明天')
    expect(dayLabel('2026-08-13', today)).toBe('后天')
  })
  it('再往后说星期几', () => {
    expect(dayLabel('2026-08-14', today)).toBe('周五')
  })
  it('认不出的字符串原样返回，不崩', () => {
    expect(dayLabel('', today)).toBe('')
    expect(dayLabel('下周三', today)).toBe('下周三')
  })
})
