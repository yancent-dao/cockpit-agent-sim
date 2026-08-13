import { describe, it, expect } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 工具目录：慢层 system 里常驻的是"每个工具一行速览"（≈0.8k token），
 * 不再是 8k token 的全量 schema。目录由 TOOLS 的 brief 数据位自动生成——
 * 加工具 = 加数据，目录自己长出来。
 */

const reg = () => createRegistry(createStore(SIGNALS, CONSTRAINTS), TOOLS)

describe('brief 数据位：目录的原料', () => {
  it('每个非黑、非元工具都有 brief，且 ≤20 字——目录行不许变小作文', () => {
    for (const t of TOOLS) {
      if (t.permission === '黑' || t.meta) continue
      expect(t.brief, `${t.name} 缺 brief`).toBeTruthy()
      expect(t.brief!.length, `${t.name} 的 brief 超 20 字`).toBeLessThanOrEqual(20)
    }
  })

  it('fast 标记只出现在彩权限工具上——先斩后奏的边界就是权限分级', () => {
    for (const t of TOOLS.filter(t => t.fast))
      expect(t.permission, `${t.name} 标了 fast 却不是彩`).toBe('彩')
  })

  it('快层工具面成型：车控/天气/媒体一步到位类在内，多步与要挑选的在外', () => {
    const fast = TOOLS.filter(t => t.fast).map(t => t.name)
    expect(fast.length).toBeGreaterThanOrEqual(14)
    // music.play 语义就是"搜到直接放"、news.headlines 就是"列表上屏"——
    // 一步到位不需要挑，圈进快层（实拍：圈在慢层让五连指令多等 3 轮 LLM）
    for (const n of ['window.set', 'climate.set', 'weather.query', 'media.control',
      'music.play', 'radio.play', 'news.headlines'])
      expect(fast, `${n} 该进快层`).toContain(n)
    // search 类要用户挑结果、door 灰权限、memory/card 要上下文——仍归慢层
    for (const n of ['navigation.search', 'music.search', 'news.read', 'door.set', 'memory.remember', 'card.show'])
      expect(fast, `${n} 不该进快层`).not.toContain(n)
  })
})

describe('registry.briefCatalog：目录生成', () => {
  it('一行一工具，含 brief，不含黑级', () => {
    const cat = reg().briefCatalog()
    expect(cat).toContain('navigation.search')
    expect(cat).toContain('搜')                 // brief 是人话
    expect(cat).not.toContain('brake')
    const lines = cat.split('\n').filter(Boolean)
    expect(lines.length).toBe(TOOLS.filter(t => t.permission !== '黑' && !t.meta).length)
  })

  it('目录远小于全量 schema——这是整个装载设计的存在理由', () => {
    const r = reg()
    const cat = r.briefCatalog()
    const full = JSON.stringify(r.schemas('openai'))
    expect(cat.length).toBeLessThan(full.length / 6)
  })
})

describe('registry.signalsFor：状态注入按工具声明裁剪', () => {
  it('window.set → 四扇窗信号（writes 路径展开占位符）', () => {
    const sigs = reg().signalsFor(['window.set'])
    expect(sigs).toContain('cabin.window.driver.position')
    expect(sigs).toContain('cabin.window.rearRight.position')
    expect(sigs).not.toContain('cabin.climate.targetTemp')
  })

  it('climate.set → 空调信号族', () => {
    const sigs = reg().signalsFor(['climate.set'])
    expect(sigs).toContain('cabin.climate.targetTemp')
    expect(sigs).toContain('cabin.climate.fanSpeed')
  })

  it('requires 声明的选装信号也算——模型得知道天窗装没装', () => {
    expect(reg().signalsFor(['sunroof.set'])).toContain('cabin.sunroof.glass.position')
  })

  it('多工具取并集，去重', () => {
    const sigs = reg().signalsFor(['window.set', 'climate.set'])
    const uniq = new Set(sigs)
    expect(uniq.size).toBe(sigs.length)
    expect(sigs).toContain('cabin.window.driver.position')
    expect(sigs).toContain('cabin.climate.power')
  })
})
