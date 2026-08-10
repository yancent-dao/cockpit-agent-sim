import { describe, it, expect } from 'vitest'
import { pickFastModels, FALLBACK_MODELS } from '../../src/agent/llm'
import type { ModelInfo } from '../../src/agent/llm'

const m = (id: string, price = 1): ModelInfo => ({ id, name: id, tools: true, promptPrice: price })

describe('快速模型筛选', () => {
  it('排除 :batch 变体 —— 批处理端点是异步的，最慢', () => {
    const out = pickFastModels([m('openai/gpt-5-nano:batch', 0.02), m('openai/gpt-5-nano', 0.05)])
    expect(out.map(x => x.id)).toEqual(['openai/gpt-5-nano'])
  })

  it('排除 :free 变体 —— 免费额度通常限流且排队', () => {
    const out = pickFastModels([m('nvidia/nemotron-nano-9b-v2:free', 0), m('qwen/qwen3.7-flash', 0.03)])
    expect(out.map(x => x.id)).toEqual(['qwen/qwen3.7-flash'])
  })

  it('排除 :thinking / :extended —— 推理档不是快模型', () => {
    expect(pickFastModels([m('x/mini:thinking'), m('x/mini:extended')])).toHaveLength(0)
  })

  it('只保留名称含快速特征的模型', () => {
    const out = pickFastModels([m('a/flash'), m('b/mini'), m('c/nano'), m('d/lite'), m('e/opus-max')])
    expect(out.map(x => x.id)).not.toContain('e/opus-max')
    expect(out).toHaveLength(4)
  })

  it('按价格升序排列', () => {
    const out = pickFastModels([m('a/flash', 0.9), m('b/mini', 0.1), m('c/lite', 0.5)])
    expect(out.map(x => x.id)).toEqual(['b/mini', 'c/lite', 'a/flash'])
  })

  it('兜底列表不含已下线模型（2026-08 实测：gemini-2.0-flash-001 与 claude-3.5-haiku 已 404）', () => {
    const ids = FALLBACK_MODELS.map(x => x.id)
    expect(ids).not.toContain('google/gemini-2.0-flash-001')
    expect(ids).not.toContain('anthropic/claude-3.5-haiku')
    expect(ids.length).toBeGreaterThan(0)
  })

  it('兜底列表自身应通过快速筛选', () => {
    expect(pickFastModels(FALLBACK_MODELS)).toHaveLength(FALLBACK_MODELS.length)
  })
})
