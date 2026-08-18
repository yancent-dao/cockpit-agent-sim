import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from '../../src/core/store'
import { createRegistry } from '../../src/tools/registry'
import { SIGNALS } from '../../src/config/signals'
import { CONSTRAINTS } from '../../src/config/constraints'
import { TOOLS } from '../../src/config/tools'

/**
 * 壁纸与主题（2026-08-18 产品决策：解禁「主题切换」——原「明确不做」
 * 里的日夜切换按新决策放开）。
 *
 * 关键设计：信号里只存**主题名/壁纸版本戳**（变更通知），壁纸图片内容
 * 走 localStorage——dataURL 几百 KB，塞进信号系统会被 bus 全量广播背着走。
 */

let store: ReturnType<typeof createStore>
let saved: Record<string, string>

beforeEach(() => {
  store = createStore(SIGNALS, CONSTRAINTS)
  saved = {}
})

const mk = (image?: any) => createRegistry(store, TOOLS, () => 1723958400000, {
  storage: { get: (k: string) => saved[k] ?? null, set: (k: string, v: string) => { saved[k] = v } },
  image,
} as any)

describe('theme.set', () => {
  it('日/夜两套，落信号', async () => {
    const r = await mk().invoke('theme.set', { mode: 'night' })
    expect(r.status).toBe('ok')
    expect(store.get('hmi.theme')).toBe('night')
  })
})

describe('wallpaper.set', () => {
  it('preset：写预设名进信号，屏端照名字渲染', async () => {
    const r = await mk().invoke('wallpaper.set', { source: 'preset', name: 'dusk' })
    expect(r.status).toBe('ok')
    expect(store.get('hmi.wallpaper')).toBe('preset:dusk')
  })

  it('generate：AI 生成 → 存 localStorage → 信号只写版本戳', async () => {
    const image = { generate: async () => ({ dataUrl: 'data:image/webp;base64,AAAA', cost: 4 }) }
    const r = await mk(image).invoke('wallpaper.set', { source: 'generate', prompt: '雪山日出' })
    expect(r.status).toBe('ok')
    expect(saved['cockpit-sim:wallpaper']).toContain('data:image/webp')
    const v = String(store.get('hmi.wallpaper'))
    expect(v.startsWith('custom:')).toBe(true)
    expect(v.length, '信号里只放版本戳，不放图').toBeLessThan(40)
  })

  it('none：清掉壁纸', async () => {
    await mk().invoke('wallpaper.set', { source: 'preset', name: 'dusk' })
    const r = await mk().invoke('wallpaper.set', { source: 'none' })
    expect(r.status).toBe('ok')
    expect(store.get('hmi.wallpaper')).toBe('')
  })

  it('没配图像服务时 generate 给人话', async () => {
    const r = await mk().invoke('wallpaper.set', { source: 'generate', prompt: 'x' })
    expect(r.status).toBe('unavailable')
    expect(r.message).not.toContain('undefined')
  })
})
