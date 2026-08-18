import { describe, it, expect } from 'vitest'
import { nextHoliday, todayIs, createHolidayClient } from '../../src/integrations/holiday'
import { createPoemClient } from '../../src/integrations/poem'

/**
 * 节假日（timor.tech）与今日诗词（jinrishici）。零 Key 零注册。
 * timor 的响应形状取自 2026-08-18 真实抓包：holiday 映射键是 MM-DD，
 * 值里 holiday:true 是放假、false 是**调休补班**——这个语义别搞反，
 * 「周六要上班」提醒的价值恰恰在 false 那半边。
 */

const YEAR: any = {
  '01-01': { holiday: true, name: '元旦', date: '2026-01-01' },
  '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' },
  '10-02': { holiday: true, name: '国庆节', date: '2026-10-02' },
  '09-27': { holiday: false, name: '国庆节前调休', date: '2026-09-27' },
}

describe('纯函数：下一个假期与今天是什么日子', () => {
  it('从今天往后找第一个放假日，同名连休算一段', () => {
    const n = nextHoliday(YEAR, '2026-08-18')
    expect(n).toEqual({ name: '国庆节', date: '2026-10-01', days: 44 })
  })
  it('顺带找最近的调休补班日——周末要上班这件事必须提前说', () => {
    const w = nextHoliday(YEAR, '2026-08-18', 'workday')
    expect(w).toEqual({ name: '国庆节前调休', date: '2026-09-27', days: 40 })
  })
  it('今天在假期里/是调休/是平日，三种口径', () => {
    expect(todayIs(YEAR, '2026-10-01')).toEqual({ kind: 'holiday', name: '国庆节' })
    expect(todayIs(YEAR, '2026-09-27')).toEqual({ kind: 'workday', name: '国庆节前调休' })
    expect(todayIs(YEAR, '2026-08-18')).toEqual({ kind: 'normal' })
  })
  it('年尾找不到就返回 null，客户端会去查下一年', () => {
    expect(nextHoliday({ '01-01': YEAR['01-01'] }, '2026-12-30')).toBeNull()
  })
})

describe('客户端', () => {
  it('holiday：本年查不到下一个假期自动翻下一年', async () => {
    const seen: string[] = []
    const c = createHolidayClient(async u => {
      seen.push(String(u))
      const y = String(u).includes('2027')
      return { ok: true, json: async () => ({ code: 0, holiday: y ? { '01-01': { holiday: true, name: '元旦', date: '2027-01-01' } } : {} }) } as any
    })
    const r = await c.query('2026-12-30')
    expect(seen[0]).toContain('/api/holiday/year/2026')
    expect(seen[1]).toContain('/api/holiday/year/2027')
    expect(r.next?.name).toBe('元旦')
  })

  it('poem：v1/all.json 原样带出处', async () => {
    const c = createPoemClient(async () => ({ ok: true, json: async () => ({ content: '万里不惜死，一朝得成功。', origin: '塞下曲', author: '高适' }) } as any))
    const p = await c.today()
    expect(p.content).toContain('万里')
    expect(p.author).toBe('高适')
  })
})
