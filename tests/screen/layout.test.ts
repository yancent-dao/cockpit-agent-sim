import { describe, it, expect } from 'vitest'
import { navForm, capForm, weatherForm } from '../../src/screen/layout'

/**
 * 尺寸放开之后，"支持某个尺寸"要落到"在那个尺寸下能看"。
 * 这里只定形态，具体排版在 CSS 里。
 */
describe('导航卡的形态随尺寸变', () => {
  it('2/3 是完整形态：地图 + 转向条 + 底部数据', () => {
    expect(navForm('2/3')).toEqual({ map: true, turnbar: true, foot: true })
  })

  it('1/2 还放得下地图，只是矮一些', () => {
    expect(navForm('1/2').map).toBe(true)
  })

  // 一格宽的地图看不出路，不如把空间让给转向指令——真车机的小卡模式
  it('1/3 退成小卡：没有地图，转向条和 ETA 都留着', () => {
    expect(navForm('1/3')).toEqual({ map: false, turnbar: true, foot: true })
  })

  it('1/6 只剩转向指令，连 ETA 都放不下', () => {
    expect(navForm('1/6')).toEqual({ map: false, turnbar: true, foot: false })
  })
})

describe('能力目录的形态随尺寸变', () => {
  it('full 铺开全部', () => {
    expect(capForm('full').mode).toBe('grid')
  })

  it('1/2 和 1/3 列得下，一列排', () => {
    expect(capForm('1/2').mode).toBe('list')
    expect(capForm('1/3').mode).toBe('list')
  })

  // 33 项塞进一格是不可能的，老实报个数
  it('1/6 只报数量', () => {
    expect(capForm('1/6').mode).toBe('count')
  })
})

describe('天气卡的形态随尺寸变', () => {
  // 1/6 是它的默认尺寸，也是最常出现的形态。现在挤了 6 行小字，主次不分
  it('1/6 只讲此刻：温度当主角，不放预报', () => {
    expect(weatherForm('1/6')).toEqual({ bigTemp: true, forecast: 0, forecastRow: false })
  })

  it('1/3 放得下三天预报，纵向排', () => {
    const f = weatherForm('1/3')
    expect(f.forecast).toBe(3)
    expect(f.forecastRow).toBe(false)
  })

  it('1/2 横向排预报，别让内容缩在左上角', () => {
    const f = weatherForm('1/2')
    expect(f.forecast).toBe(3)
    expect(f.forecastRow).toBe(true)
    expect(f.bigTemp).toBe(true)
  })
})
