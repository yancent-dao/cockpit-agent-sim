import { describe, it, expect } from 'vitest'
import { parseTurn, soundsLikeAssistant, createUserBot } from './userBot'

describe('用户机器人：解析', () => {
  it('从 JSON 里取话术与结束标志', () => {
    expect(parseTurn('{"say":"帮我开窗","done":false}')).toEqual({ say: '帮我开窗', done: false })
  })

  it('模型多说两句时容错取 JSON', () => {
    expect(parseTurn('好的：\n```json\n{"say":"去机场","done":true}\n```').say).toBe('去机场')
  })
})

/**
 * 实测跑批里，扮用户的模型跑着跑着开始替助手宣布结果
 * （"帮你查到——西门在圆明园路那边"），整场对话就废了。
 * 光靠 Prompt 里写"不要扮演助手"拦不住，得有机制。
 */
describe('用户机器人：串戏检测', () => {
  it('替助手宣布已完成的动作算串戏', () => {
    expect(soundsLikeAssistant('帮你查到西门在圆明园路那边')).toBe(true)
    expect(soundsLikeAssistant('导航已经帮你设好了，全程 20 公里')).toBe(true)
    expect(soundsLikeAssistant('好嘞，天府三街已存到"家"。后续直接说"回家"就行。')).toBe(true)
    expect(soundsLikeAssistant('已经帮您打开车窗了')).toBe(true)
  })

  it('导航播报口吻算串戏', () => {
    expect(soundsLikeAssistant('前方两百米右转进青华路')).toBe(true)
  })

  it('正常用户话术不算', () => {
    expect(soundsLikeAssistant('帮我导航去机场')).toBe(false)
    expect(soundsLikeAssistant('开了吗？我怎么没感觉')).toBe(false)
    expect(soundsLikeAssistant('就选第一个吧')).toBe(false)
    expect(soundsLikeAssistant('好，谢谢')).toBe(false)
    expect(soundsLikeAssistant('我已经把车停好了，想走路过去')).toBe(false)
  })
})

describe('用户机器人：串戏时重说', () => {
  const bot = (replies: string[]) => {
    const seen: any[] = []
    let i = 0
    return {
      seen,
      bot: createUserBot({
        chat: async (_s, messages) => { seen.push(messages); return replies[i++] ?? replies.at(-1)! },
      }),
    }
  }

  it('串戏就重来一次，取重说的那句', async () => {
    const { bot: b } = bot([
      '{"say":"帮你查到西门在圆明园路那边","done":false}',
      '{"say":"那走西门吧","done":false}',
    ])
    expect((await b.next('去清华接人', [])).say).toBe('那走西门吧')
  })

  it('重说还是串戏就放弃，不能无限重试拖垮跑批', async () => {
    const { bot: b, seen } = bot(['{"say":"导航已经帮你设好了","done":false}'])
    const r = await b.next('去机场', [])
    expect(r.say).toBeTruthy()
    expect(seen.length).toBeLessThanOrEqual(3)
  })
})

describe('用户机器人：历史用显式署名，不靠 role', () => {
  it('把谁说的写进正文——连续两条 user 消息会让模型分不清自己是谁', async () => {
    const seen: any[] = []
    const b = createUserBot({
      chat: async (_s, messages) => { seen.push(messages); return '{"say":"好","done":true}' },
    })
    await b.next('开窗', [
      { role: 'user', content: '帮我开窗' },
      { role: 'assistant', content: '开好了' },
    ])
    const text = JSON.stringify(seen[0])
    expect(text).toContain('我说：帮我开窗')
    expect(text).toContain('助手说：开好了')
  })
})
