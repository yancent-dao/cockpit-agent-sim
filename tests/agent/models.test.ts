import { describe, it, expect } from 'vitest'
import { stripThinking, toSpeech } from '../../src/agent/llm'

/* 话术是拿去念的，Markdown 念出来是噪音。模型屡教不改，只能在机制层清掉 */
describe('toSpeech：把模型话术清理成能念的样子', () => {
  it('去掉加粗标记但保留文字', () => {
    expect(toSpeech('途经点是 **小桔充电**，往西走 290 米')).toBe('途经点是 小桔充电，往西走 290 米')
  })

  it('去掉列表符号与标题井号', () => {
    expect(toSpeech('- 空调已开\n- 座椅加热已开')).toBe('空调已开 座椅加热已开')
    expect(toSpeech('## 天气\n晴 25 度')).toBe('天气 晴 25 度')
  })

  it('多行折成一行——语音没有换行这回事', () => {
    expect(toSpeech('路线定好了。\n\n全程12公里。')).toBe('路线定好了。 全程12公里。')
  })

  it('顺手清掉思考标签', () => {
    expect(toSpeech('</mm:think>好嘞')).toBe('好嘞')
  })

  it('正常话术原样不动', () => {
    expect(toSpeech('空调开了，24度')).toBe('空调开了，24度')
  })
})

/* 思考标签会漏进话术直接念给用户听——实测 MiniMax M3 会吐 </mm:think> */
describe('stripThinking：清理各家模型的思考标签', () => {
  it('清掉成对的 think 块', () => {
    expect(stripThinking('<think>盘算一下</think>空调开好了')).toBe('空调开好了')
  })

  it('清掉只剩尾标签的残留（实测 MiniMax M3）', () => {
    expect(stripThinking('</mm:think>儿童锁关了。')).toBe('儿童锁关了。')
  })

  it('清掉带命名空间的成对标签', () => {
    expect(stripThinking('<mm:think>x</mm:think>好的')).toBe('好的')
  })

  it('顺手去掉首尾空白，正常话术不受影响', () => {
    expect(stripThinking('\n\n都安排上了\n')).toBe('都安排上了')
    expect(stripThinking('空调开了，24度')).toBe('空调开了，24度')
  })

  it('空内容返回空串，不炸', () => {
    expect(stripThinking(undefined)).toBe('')
  })
})
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

describe('toSpeech：伪工具调用残片剥离', () => {
  // 实拍：MiniMax 最后一轮被撤了工具，把调用写成私有格式文本
  // "]<]minimax[>[<tool_call>..." 并被整段念给用户
  it('从第一个残片标记起截断，前面的话保留', async () => {
    const { toSpeech } = await import('../../src/agent/llm')
    expect(toSpeech('新闻卡我先收一下。]<]minimax[>[<tool_call> ]<]minimax[>[<invoke name="card_dismiss">'))
      .toBe('新闻卡我先收一下。')
    expect(toSpeech('好了<tool_call>{"name":"x"}</tool_call>')).toBe('好了')
    expect(toSpeech('正常的话术不受影响')).toBe('正常的话术不受影响')
  })
})
