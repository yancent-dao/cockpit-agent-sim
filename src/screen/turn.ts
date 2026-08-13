/**
 * 转向条文案解析。高德给的是一整句"沿人民南路四段向南行驶1.2公里后右转进入机场高速"，
 * 转向条要拆成三块：还有多远 · 做什么 · 上哪条路。
 *
 * 路名不是噪音——它是用户确认自己没走错的唯一依据，车机上必须留。
 */

const TURN_ICONS: Array<[RegExp, string]> = [
  [/掉头/, '⤺'], [/环岛/, '⟳'],
  [/靠左|左前/, '↖'], [/靠右|右前/, '↗'],
  [/左转|向左/, '↰'], [/右转|向右/, '↱'],
  [/到达|终点/, '◎'],
]

/** 动作词，按长度降序匹配，"左前方转弯"要先于"左转"命中 */
const ACTIONS = [
  '左前方转弯', '右前方转弯', '向左前方行驶', '向右前方行驶',
  '到达目的地', '到达途经点', '到达终点',
  '左转', '右转', '掉头', '靠左', '靠右', '直行', '进入环岛', '驶出环岛',
]

export interface Turn {
  /** "1.2公里"，没有距离时为空串 */
  dist: string
  /** "右转"，认不出格式时兜底成整句 */
  action: string
  /** "机场高速"，没有"进入XX"时为空串 */
  road: string
  icon: string
}

export function parseTurn(instruction: string): Turn {
  const s = instruction.trim()
  const d = s.match(/(\d+(?:\.\d+)?)\s*(米|公里|千米)/)
  const icon = TURN_ICONS.find(([re]) => re.test(s))?.[1] ?? '↑'

  // 距离之后才是动作，前面全是"沿XX路向Y行驶"这类起点描述
  const tail = d ? s.slice(s.indexOf(d[0]) + d[0].length) : s
  const action = ACTIONS.find(a => tail.includes(a))
    ?? ACTIONS.find(a => s.includes(a))
    ?? s   // 认不出就整句兜底，宁可长也别出空白条

  const road = tail.match(/进入(.+?)(?:[，,。]|$)/)?.[1]?.trim() ?? ''

  return { dist: d ? `${d[1]}${d[2]}` : '', action, road, icon }
}

/**
 * 状态条的车速×挡位芯片。挡位显示真实信号——之前从车速猜（<1 就算 P 挡），
 * 挂 R 倒车会显示 D 挡。gear 缺失（老面板没发这个字段）才退回猜。
 */
export function speedChip(speed: number, gear?: string): string {
  const g = (gear ?? (speed < 1 ? 'p' : 'd')).toUpperCase()
  return `${speed < 1 ? '静止' : `${Math.round(speed)} km/h`} · ${g} 挡`
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 天气预报的日期。车机上没人读"2026-08-11"。
 * @param now 注入当天，便于测试；实际调用不传
 */
export function dayLabel(date: string, now = new Date()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  // 加 T00:00:00 强制按本地时间解析。裸 'YYYY-MM-DD' 走 UTC 午夜，
  // 东八区以西的机器上整个日期会差一天
  const local = new Date(`${date}T00:00:00`)
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((midnight(local) - midnight(now)) / 86_400_000)
  return ['今天', '明天', '后天'][diff] ?? WEEK[local.getDay()]
}
