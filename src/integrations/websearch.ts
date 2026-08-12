/**
 * 联网搜索。
 *
 * 这个 Tool 跟其它十几个都不一样：它不发 HTTP 给某个 CP，而是**让模型自己
 * 带着联网能力再想一遍**（OpenRouter 的 `:online` 后缀，底层是 Exa）。
 *
 * 为什么绕这一圈：Tavily / Brave / Serper 这类搜索 API **故意关掉 CORS**，
 * 防的就是前端 Key 泄露，是设计意图不是疏漏，零后端下绕不过去。而 OpenRouter
 * 这条通道项目本来就在用。
 *
 * 三条路里选的第三条：
 * - 让 Agent 判断"这问题要不要联网" → 那是意图分支，违反硬约束
 * - web 插件常开 → 每轮都可能触发计费，模型还会在不需要时搜
 * - **做成真 Tool，调用时发一次独立的单轮请求** → 对 Agent 就是个普通工具，
 *   计费只在调用时发生，不需要任何意图判断
 *
 * 代价是一条新的依赖边 registry → llm。llm 本质上也是三方服务，
 * 放这里注入跟高德同一个模式。
 */

export interface WebSearchResult {
  answer: string
}

export class WebSearchError extends Error {
  constructor(message: string, readonly code?: string) { super(message) }
}

/** 只要 chat 能力，不要整个 LLM 接口——依赖面越小越好 */
export type SearchChat = (system: string, prompt: string) => Promise<string>

export function createWebSearch(chat: SearchChat) {
  return {
    async search(query: string): Promise<WebSearchResult> {
      const answer = await chat(
        // 这是给"搜索模型"的指令，跟主 Agent 的人设无关——
        // 它的产出会成为主 Agent 的 Tool 返回值，再由主 Agent 转成车里的话
        '你是搜索助手。用联网结果回答问题，简明扼要，只讲事实。'
        + '答案会被车载语音助手转述给正在开车的人，所以：不要 Markdown、不要列表符号、'
        + '不要"根据搜索结果"这类套话，直接给结论。查不到就说查不到。',
        query,
      )
      if (!answer.trim()) throw new WebSearchError('没搜到什么', 'EMPTY')
      return { answer: answer.trim() }
    },
  }
}

export type WebSearchClient = ReturnType<typeof createWebSearch>
