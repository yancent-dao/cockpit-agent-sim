/**
 * Open-Meteo 天气客户端（2026-08-15 替换高德天气的产品决策）。
 *
 * ## 为什么换、为什么是它
 *
 * 高德 `weatherInfo?extensions=all` 只给 4 天日/夜温度，**不给逐小时** ——
 * 渲染层的 hourly 块（车里天气卡的主角）干等了一个月（工程手册 已知待办）。
 * Open-Meteo 三个特性正好踩中本项目的第一性约束：
 *
 *   · **零 Key 零注册** —— .env.local 不多一行，单文件版那个
 *     「import.meta.env 读不到」的坑直接绕开
 *   · **官方 CORS** —— 为浏览器前端设计，零后端硬约束直接满足
 *   · **168 小时逐时** —— UI 只要 12 小时，余量十倍
 *
 * 中国数据走它的多模型混合（含中国气象局 CMA GRAPES）。已知短板：
 * 没有政府发布的恶劣天气预警、没有生活指数 —— 产品已知并接受。
 * 数据许可 CC BY 4.0，署名记在 工程手册（demo 场景的合规成本）。
 *
 * ## 边界
 *
 * 这一层只做协议适配：WMO 天气码 → 中文、风向度数 → 方位、km/h → 风力级
 * 都是**编码转换的数据表**，不是业务逻辑。它收坐标不收城市名 ——
 * 地名解析仍然归高德 geocode（各家干各家最擅长的）。
 */
import type { Fetcher } from './amap'
import { api } from '../config/upstream'

const ENDPOINT = () => `${api('openmeteo')}/v1/forecast`
/** per-request 超时。跟 radio(5s)/itunes(4s) 同一个思路：fetch 先抛，副作用走不到 */
const TIMEOUT_MS = 6000
/** 逐时取几根。band 档要 12，多取没用 */
const HOURS = 12

export class OmError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

/**
 * WMO 天气码 → 中文。**名单是数据**，词要能被 weatherIcon 的正则认出来
 * （晴/云/雨/雪/雷/雾）。码表来自 WMO 4677 的 Open-Meteo 子集。
 */
const WMO: Record<number, string> = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '冻雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '暴雨',
  85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
}
/** 没见过的码退到"多云"——不显示数字，也不至于错得离谱 */
export const wmoLabel = (code: number): string => WMO[code] ?? '多云'

/** 风向十六分圆太细，车机上八方位够了 */
const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
/** 蒲福风级的 km/h 上限（0-12 级）。查表不算式 —— 这是标准不是逻辑 */
const BEAUFORT = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117]
export function windLabel(deg: number, kmh: number): string {
  const dir = DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8]
  const level = BEAUFORT.findIndex(max => kmh <= max)
  return `${dir}风 ${level < 0 ? 12 : level}级`
}

export interface OmWeather {
  now: { temperature: number; weather: string; wind: string; humidity: number; feelsLike: number }
  range: { high: number; low: number }
  hourly: Array<{ time: string; temp: number; pop: number; weather: string }>
  forecast: Array<{ date: string; dayWeather: string; nightWeather: string; dayTemp: number; nightTemp: number }>
}

export interface OmOpts { timeoutMs?: number }

export function createOpenMeteoClient(fetcher: Fetcher, opts: OmOpts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS

  async function forecast(lat: number, lon: number): Promise<OmWeather> {
    const qs = new URLSearchParams({
      latitude: String(lat), longitude: String(lon),
      current: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,apparent_temperature',
      hourly: 'temperature_2m,weather_code,precipitation_probability',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min',
      // auto 不写死 Asia/Shanghai —— 查国外城市时逐时要按当地时区对齐
      timezone: 'auto', forecast_days: '5',
    })
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new OmError('天气服务没响应，等太久', 'TIMEOUT')), timeoutMs)
    })
    const res = await Promise.race([fetcher(`${ENDPOINT()}?${qs}`), timeout]).finally(() => clearTimeout(timer))
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new OmError(json?.reason || '天气服务没接受这次请求', 'UPSTREAM')

    const cur = json?.current
    const h = json?.hourly
    const d = json?.daily
    if (!cur || !h?.time?.length || !d?.time?.length)
      throw new OmError('天气服务没给出数据', 'NO_DATA')

    /**
     * **逐时从当前小时切起**（实测坑）：响应从今天 00:00 给起，
     * 直接取前 12 个就是给用户看凌晨的过去时。按 current.time 的整点对齐。
     */
    const nowHour = String(cur.time ?? '').slice(0, 13)   // '2026-08-17T11'
    let start = h.time.findIndex((t: string) => t.slice(0, 13) >= nowHour)
    if (start < 0) start = 0
    const hourly = h.time.slice(start, start + HOURS).map((time: string, i: number) => ({
      time,
      temp: Number(h.temperature_2m[start + i]),
      pop: Number(h.precipitation_probability?.[start + i] ?? 0),
      weather: wmoLabel(Number(h.weather_code?.[start + i])),
    }))

    const forecast = d.time.map((date: string, i: number) => ({
      date,
      // Open-Meteo 的 daily 只有一个码，日夜共用 —— 比编一个夜间码诚实
      dayWeather: wmoLabel(Number(d.weather_code[i])),
      nightWeather: wmoLabel(Number(d.weather_code[i])),
      dayTemp: Number(d.temperature_2m_max[i]),
      nightTemp: Number(d.temperature_2m_min[i]),
    }))

    return {
      now: {
        temperature: Number(cur.temperature_2m),
        weather: wmoLabel(Number(cur.weather_code)),
        wind: windLabel(Number(cur.wind_direction_10m), Number(cur.wind_speed_10m)),
        humidity: Number(cur.relative_humidity_2m),
        feelsLike: Number(cur.apparent_temperature),
      },
      range: { high: forecast[0].dayTemp, low: forecast[0].nightTemp },
      hourly, forecast,
    }
  }

  return { forecast }
}

export type OpenMeteoClient = ReturnType<typeof createOpenMeteoClient>
