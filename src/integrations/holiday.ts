/**
 * 节假日/调休（timor.tech）。零 Key 零注册，全年放假 + 调休补班一张表。
 *
 * 语义要点：holiday:true 是放假，false 是**调休补班**——「周六要上班」
 * 提醒的价值恰恰在 false 那半边。个人维护项目：高频会封、无 UA 请求 403
 * （浏览器 UA 天然没问题；node 侧补一个）。
 */
import { api } from '../config/upstream'

export interface DayInfo { holiday: boolean; name: string; date: string }
export interface Found { name: string; date: string; days: number }

export class HolidayError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

export type Fetcher = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json(): Promise<any> }>

const dayMs = 86400000
const diffDays = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / dayMs)

/** 从 today 往后找第一个放假日（或 kind='workday' 找调休补班日）。找不到 null */
export function nextHoliday(year: Record<string, DayInfo>, today: string,
                            kind: 'holiday' | 'workday' = 'holiday'): Found | null {
  const want = kind === 'holiday'
  const hit = Object.values(year)
    .filter(d => d.holiday === want && d.date > today)
    .sort((a, b) => a.date.localeCompare(b.date))[0]
  return hit ? { name: hit.name, date: hit.date, days: diffDays(today, hit.date) } : null
}

/** 今天是放假 / 调休补班 / 平日 */
export function todayIs(year: Record<string, DayInfo>, today: string):
    { kind: 'holiday' | 'workday' | 'normal'; name?: string } {
  const d = Object.values(year).find(x => x.date === today)
  return d ? { kind: d.holiday ? 'holiday' : 'workday', name: d.name } : { kind: 'normal' }
}

export function createHolidayClient(fetcher: Fetcher) {
  const fetchYear = async (y: number): Promise<Record<string, DayInfo>> => {
    let res
    try {
      // node 侧无 UA 会 403；浏览器会忽略这个禁改 header，无副作用
      res = await fetcher(`${api('timor')}/api/holiday/year/${y}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 cockpit-sim' } })
    } catch { throw new HolidayError('节假日服务连不上', 'NETWORK') }
    if (!res.ok) throw new HolidayError(`节假日服务返回 ${res.status}`, 'HTTP')
    const json = await res.json()
    if (json.code !== 0) throw new HolidayError('节假日数据异常', 'DATA')
    return json.holiday ?? {}
  }

  /** 今天的口径 + 下一个假期 + 最近的调休补班。年尾查不到自动翻下一年 */
  const query = async (today: string) => {
    const y = Number(today.slice(0, 4))
    let year = await fetchYear(y)
    let next = nextHoliday(year, today)
    if (!next) {
      year = { ...year, ...await fetchYear(y + 1) }
      next = nextHoliday(year, today)
    }
    return { today: todayIs(year, today), next, makeup: nextHoliday(year, today, 'workday') }
  }

  return { query }
}

export type HolidayClient = ReturnType<typeof createHolidayClient>
