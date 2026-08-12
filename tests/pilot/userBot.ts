/**
 * 用户机器人 —— 只负责"说人话"。
 *
 * 它不做任何判断（好不好、对不对全部由我人工评审），只按场景目标生成真实用户话术：
 * 口语、可能模糊、会追问、会改主意。看到 Agent 的回复后决定下一句说什么，或者结束。
 */

import { stripThinking } from '../../src/agent/llm'

export interface BotTurn {
  /** 用户这一轮说的话 */
  say: string
  /** 目标已达成或无法继续，本场景可以收尾 */
  done: boolean
}

export interface UserBotDeps {
  /** 独立于被测 Agent 的 LLM 调用——扮用户的模型和被测模型互不干扰 */
  chat(system: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string>
}

const SYSTEM = `你在扮演一个坐在车里的普通用户，正在跟车载语音助手说话。

规则：
1. 你是真人，不是测试脚本。说话口语、简短，像平时跟人说话那样。
2. 你不懂技术，不知道什么是 Tool、卡片、API。不要提这些词。
3. 按给你的目标推进对话。助手问你问题就正常回答，助手做完了你可以确认或提出下一个诉求。
4. 目标达成了、或者助手明确说做不到、或者你觉得没必要继续了，就结束。
5. 每次只说一句话（可以是一个短句，也可以是两个诉求连在一起，看真人会怎么说）。
6. 只说中文，只说跟这次目标有关的话。不要跑题、不要输出与开车无关的内容。
7. **你只是提要求的人。你不知道系统内部做了什么，也没有任何查询能力。**
   绝对不要说这几类话：
   - 替助手宣布结果："车窗已经打开了""导航已经取消啦""已存到家"
   - 提供助手才查得到的信息："西门在圆明园路那边""全程 160 公里"
   - 导航播报："前方 200 米右转"
   你只能看到助手回复了什么。要确认就问："开了吗？""到底多远？"
8. say 不能为空。没什么好说的就说"好，谢谢"并把 done 设为 true。
9. **始终盯着你的目标**。目标里还有没做完的事（比如"走一半再取消"），
   就继续推进它，不要被助手带跑偏聊别的。

输出严格用这个 JSON 格式，不要有别的内容：
{"say": "你这一轮说的话", "done": false}

目标达成或该收尾时，done 传 true，say 里放你最后要说的话（比如"好，谢谢"）。`

/**
 * 串戏检测：扮用户的模型跑几轮后会开始替助手宣布结果
 * （实测："帮你查到——西门在圆明园路那边"、"天府三街已存到家"），
 * 一旦串戏整场对话就废了，看不出被测产品的真实表现。
 * Prompt 里写"不要扮演助手"拦不住，只能靠机制。
 */
const ASSISTANT_TONE: RegExp[] = [
  /(帮|给)(你|您|你们)(查到|找到|设好|存|叫|安排好|规划)/,
  /(已经?|都)(帮|给)(你|您)/,
  /(导航|路线|车窗|空调|座椅|音乐|地址)(已经?|都)(设|开|关|存|规划|取消|好)/,
  /前(方|面)\s*[\d一二两三四五六七八九十百千]+\s*(米|公里)/,   // 导航播报
  /已存到|已保存为|后续直接说/,
]
export const soundsLikeAssistant = (text: string) => ASSISTANT_TONE.some(re => re.test(text))

/** 历史折成带署名的正文。靠 role 区分会出现连续两条 user，模型自己就分不清是谁了 */
const transcript = (history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
  history.map(m => `${m.role === 'user' ? '我说' : '助手说'}：${m.content}`).join('\n')

export function createUserBot({ chat }: UserBotDeps) {
  return {
    /**
     * @param goal 场景目标
     * @param history 对话历史（user = 用户机器人自己，assistant = 被测 Agent）
     */
    async next(goal: string, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<BotTurn> {
      const base = `【你这次的目标】${goal}\n\n【到目前为止的对话】\n${transcript(history) || '（还没开始）'}\n\n轮到你说话了。`
      let turn = parseTurn(await chat(SYSTEM, [{ role: 'user', content: base }]))
      // 串戏就让它重说一次；再串就认了，不能为这个把跑批拖死
      if (soundsLikeAssistant(turn.say)) {
        const scold = `${base}\n\n注意：你刚才说的是「${turn.say}」——那是助手才会说的话。`
          + `你是坐在车里提要求的人，不知道系统做没做成，也不会播报路线。重说一句。`
        turn = parseTurn(await chat(SYSTEM, [{ role: 'user', content: scold }]))
      }
      return turn
    },
  }
}

/** 历史是用"我说：…"喂进去的，机器人学着学着把署名也带进了话术，得剥掉 */
const clean0 = (v: string) => stripThinking(v).replace(/^\s*(我说|用户|乘客|车主)\s*[：:]\s*/, '').trim()

/** 模型偶尔会用 ```json 包裹、混进思考标签或多说两句，这里做容错解析 */
export function parseTurn(raw: string): BotTurn {
  const clean = stripThinking(raw)
  const json = clean.match(/\{[\s\S]*\}/)?.[0]
  if (json) {
    try {
      const o = JSON.parse(json)
      if (typeof o.say === 'string') return { say: clean0(o.say), done: Boolean(o.done) }
    } catch { /* 落到下面的正则捞 */ }
  }
  // JSON 不合法（少个括号、用了单引号、键没加引号）时把 say 的值捞出来。
  // 直接把残骸当话术会让"用户"说出 `": "帮我导航…", "done": false}` 这种东西——实测发生过
  const byKey = clean.match(/["']?say["']?\s*:\s*["']([^"']+)["']/)?.[1]
  // 连 say 这个键都被截掉时，按引号切开取最长的一段——分隔符碎片（": "、", "）总是短的。
  // 不能用配对正则：开头那个孤儿引号会跟后面的配错对，把真正的话术夹在中间跳过去
  const longest = /["']?done["']?\s*:/.test(clean)
    ? clean.split(/["']/).map(v => v.trim())
        .filter(v => v.length > 1 && /[\u4e00-\u9fa5a-z]/i.test(v) && !/^(say|done|true|false)$/i.test(v))
        .sort((a, b) => b.length - a.length)[0]
    : undefined
  const salvaged = byKey ?? longest
  if (salvaged) return { say: clean0(salvaged), done: /["']?done["']?\s*:\s*true/.test(clean) }

  // 完全不像 JSON，整段就是用户说的话。注意也要走 clean0——
  // 这条兜底路径一开始漏了剥前缀，跑批里真冒出过"我说：就是腾讯那个"
  return { say: clean0(clean).slice(0, 200), done: false }
}
