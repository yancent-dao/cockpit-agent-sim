import { describe, it, expect } from 'vitest'
import { createOpenMeteoClient, wmoLabel, windLabel } from '../../src/integrations/openmeteo'

/**
 * ══════════ Open-Meteo：换掉高德天气的原因就一个 —— 逐小时 ══════════
 *
 * 高德 weatherInfo 只给 4 天日/夜温度，渲染层的 hourly 块干等了一个月
 * （工程手册 已知待办）。Open-Meteo：零 Key 零注册（单文件版那个
 * "import.meta.env 读不到"的坑直接绕开）、官方 CORS、168 小时逐时。
 *
 * 真实响应形状 2026-08-17 实测过：hourly 从**今天 00:00** 开始给而不是
 * 从现在开始 —— 切片要按 current.time 对齐，不对齐的话凌晨的柱子全是过去时。
 */

/** 造一份真实形状的响应（字段名照抄实测 JSON） */
const reply = (over: any = {}) => ({
  current: { time: '2026-08-17T11:15', temperature_2m: 22.5, relative_humidity_2m: 93,
    weather_code: 63, wind_speed_10m: 7.1, wind_direction_10m: 353, apparent_temperature: 26.0 },
  hourly: {
    time: Array.from({ length: 48 }, (_, i) => `2026-08-1${7 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`),
    temperature_2m: Array.from({ length: 48 }, (_, i) => 20 + (i % 10)),
    weather_code: Array.from({ length: 48 }, () => 2),
    precipitation_probability: Array.from({ length: 48 }, (_, i) => i % 2 ? 80 : 10),
  },
  daily: {
    time: ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'],
    weather_code: [82, 82, 80, 53, 51],
    temperature_2m_max: [25.4, 24.7, 26.8, 30.3, 30.9],
    temperature_2m_min: [21.8, 21.9, 21.0, 21.3, 22.8],
  },
  ...over,
})

const mk = (body: any = reply(), ok = true) => {
  const seen: string[] = []
  const fetcher = async (url: string) => { seen.push(url); return { ok, json: async () => body } }
  return { fetcher, seen }
}

describe('请求形状', () => {
  it('打 open-meteo 的 forecast 端点，带坐标和 timezone=auto', async () => {
    const { fetcher, seen } = mk()
    await createOpenMeteoClient(fetcher as any).forecast(30.66, 104.06)
    expect(seen[0]).toContain('api.open-meteo.com/v1/forecast')
    expect(seen[0]).toContain('latitude=30.66')
    expect(seen[0]).toContain('longitude=104.06')
    // auto 而不是写死 Asia/Shanghai —— 查国外城市时按当地时区对齐逐时
    expect(seen[0]).toContain('timezone=auto')
  })
})

describe('WMO 天气码 → 中文', () => {
  /** 名单是数据。词要能被 weatherIcon 的正则认出来（晴/云/雨/雪/雷/雾） */
  it('常见码都有人话', () => {
    expect(wmoLabel(0)).toBe('晴')
    expect(wmoLabel(2)).toBe('多云')
    expect(wmoLabel(3)).toBe('阴')
    expect(wmoLabel(45)).toBe('雾')
    expect(wmoLabel(63)).toBe('中雨')
    expect(wmoLabel(75)).toBe('大雪')
    expect(wmoLabel(95)).toBe('雷阵雨')
  })

  it('没见过的码不显示数字 —— 退到"多云"这种不至于错得离谱的', () => {
    expect(wmoLabel(999)).not.toMatch(/\d/)
  })
})

describe('风：度数 → 方位，km/h → 风力级', () => {
  it('353° 是北风，7.1km/h 是 2 级', () => {
    expect(windLabel(353, 7.1)).toBe('北风 2级')
  })
  it('八个方位都对得上', () => {
    expect(windLabel(45, 20)).toContain('东北风')
    expect(windLabel(180, 20)).toContain('南风')
    expect(windLabel(270, 20)).toContain('西风')
  })
})

describe('归一化到卡片形状', () => {
  it('now：温度/中文天气/风/湿度/体感', async () => {
    const { fetcher } = mk()
    const w = await createOpenMeteoClient(fetcher as any).forecast(30.66, 104.06)
    expect(w.now).toMatchObject({ temperature: 22.5, weather: '中雨', humidity: 93 })
    expect(w.now.wind).toBe('北风 2级')
    expect(w.now.feelsLike).toBe(26.0)
  })

  it('range 是今天的最高最低', async () => {
    const { fetcher } = mk()
    const w = await createOpenMeteoClient(fetcher as any).forecast(30.66, 104.06)
    expect(w.range).toEqual({ high: 25.4, low: 21.8 })
  })

  /**
   * **逐时从当前小时切起** —— 响应从今天 00:00 给起，直接拿前 12 个
   * 就是给用户看凌晨的过去时。current.time 是 11:15 → 第一根柱子是 11 点。
   */
  it('hourly 从当前小时对齐，取 12 根', async () => {
    const { fetcher } = mk()
    const w = await createOpenMeteoClient(fetcher as any).forecast(30.66, 104.06)
    expect(w.hourly).toHaveLength(12)
    expect(w.hourly[0].time).toBe('2026-08-17T11:00')
    expect(w.hourly[0]).toMatchObject({ temp: 20 + (11 % 10), pop: 80 })
  })

  it('forecast 是 5 天，日夜温对应 max/min，天气是中文', async () => {
    const { fetcher } = mk()
    const w = await createOpenMeteoClient(fetcher as any).forecast(30.66, 104.06)
    expect(w.forecast).toHaveLength(5)
    expect(w.forecast[0]).toMatchObject({ date: '2026-08-17', dayTemp: 25.4, nightTemp: 21.8 })
    expect(w.forecast[0].dayWeather).not.toMatch(/\d/)
  })
})

describe('出错时说人话', () => {
  it('HTTP 不 ok → UPSTREAM', async () => {
    const { fetcher } = mk({ reason: 'Invalid latitude' }, false)
    await expect(createOpenMeteoClient(fetcher as any).forecast(999, 0))
      .rejects.toMatchObject({ code: 'UPSTREAM' })
  })

  it('返回里缺关键字段 → NO_DATA，不吐一张空卡', async () => {
    const { fetcher } = mk({})
    await expect(createOpenMeteoClient(fetcher as any).forecast(30, 104))
      .rejects.toMatchObject({ code: 'NO_DATA' })
  })

  /** per-request 超时，跟 radio/itunes 同一个思路：fetch 先抛，副作用走不到 */
  it('超时抛 TIMEOUT 不无限等', async () => {
    const fetcher = () => new Promise<never>(() => {})
    await expect(createOpenMeteoClient(fetcher as any, { timeoutMs: 20 }).forecast(30, 104))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('daily()：旅行卡的 16 天逐日预报（2026-08-25 行程带天气）', () => {
  const mk = (json: any, capture?: { url?: string }) =>
    createOpenMeteoClient(async (url: string) => {
      if (capture) capture.url = url
      return { ok: true, json: async () => json } as any
    })

  const dailyReply = {
    daily: {
      time: ['2026-09-06', '2026-09-07'],
      weather_code: [0, 61],
      temperature_2m_max: [21.4, 18.2],
      temperature_2m_min: [9.1, 8.0],
    },
  }

  it('请求 16 天、只要 daily 三个字段', async () => {
    const cap: { url?: string } = {}
    await mk(dailyReply, cap).daily(25.04, 102.71, 16)
    expect(cap.url).toContain('forecast_days=16')
    expect(cap.url).toContain('daily=')
    expect(cap.url).not.toContain('hourly=')
  })

  it('归一化成行程要的形状：date · 天气词 · 高低温', async () => {
    const days = await mk(dailyReply).daily(25.04, 102.71, 16)
    expect(days).toEqual([
      { date: '2026-09-06', weather: '晴', hi: 21, lo: 9 },
      { date: '2026-09-07', weather: '小雨', hi: 18, lo: 8 },
    ])
  })

  it('没数据抛人话错', async () => {
    await expect(mk({}).daily(25, 102, 16)).rejects.toThrow(/没给出数据/)
  })
})
