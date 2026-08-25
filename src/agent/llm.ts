import { api } from '../config/upstream'
export interface Msg {
  /**
   * system 只用于**跨会话前情摘要**那一条（thread 第 0 位）。
   * 常规的 system prompt 走 LLMRequest.system 字段，不进 thread。
   * 摘要不能用 assistant——那样模型会当成"自己刚说过的话"接着往下讲（实拍踩过）。
   */
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/**
 * 模型调用失败的人话化（原则 4：message 写人话不写日志）。
 * 实拍：慢层撞锁区模型，403 的英文 JSON 原样蹦给用户。
 * 状态码是形状判断不是内容判断；正文只用来分辨 403 的两种含义
 * （OpenRouter 用 403 既表锁区也表内容审核），不往外带。
 */
export function llmErrorText(status: number, body: string): string {
  if (status === 401) return '模型没连上：API Key 不对或过期了，在控制面板里重新填一下'
  if (status === 402) return '模型没连上：账户额度用完了，去 OpenRouter 充值或换个免费模型'
  if (status === 403) {
    if (/region|country|location/i.test(body))
      return '这个模型在当前网络出口所在的地区不可用——换一个不锁区的模型，' +
        '或检查代理（浏览器走 VPN 不等于 dev server 也走：它只认启动终端里的 HTTPS_PROXY）'
    return '模型拒绝了这次请求（403）——换个模型试试'
  }
  if (status === 429) {
    /**
     * 2026-08-25 实拍：钱够、免费档也下架了还在 429——那是**上游 provider
     * 满载**（热门便宜模型的最快提供方常常也最挤），跟账户配额是两回事，
     * 一刀切说"请求太频繁"会让用户以为是自己的问题。按响应体分层。
     */
    const provider = /"provider_name"\s*:\s*"([^"]+)"/.exec(body)?.[1]
    if (provider || /provider returned error|upstream/i.test(body))
      return `模型的上游服务商${provider ? `（${provider}）` : ''}正忙——不是你的账户问题，` +
        '稍等再试，总撞就换个模型'
    if (/free-models|free_models/i.test(body))
      return '账户级限流：免费档每分钟只有约 20 次——换成付费模型'
    return '模型限流了：请求太频繁，稍等几秒再说一次'
  }
  if (status >= 500) return '模型服务临时故障，稍后再试；总失败就换个模型'
  return `模型没连上（${status}）——换个模型试试，或看浏览器控制台的完整响应`
}

export interface LLMRequest {
  system: string
  messages: Msg[]
  tools: any[]
  /** 输出上限。快层话术轮用它拦住"撤了工具就开始长思考"的模型（实拍 24s） */
  maxTokens?: number
}

export interface LLMReply {
  text?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>
}

export interface ModelInfo {
  id: string
  name: string
  /** 是否支持 function calling */
  tools: boolean
  contextLength?: number
  promptPrice?: number
}

export interface LLM {
  chat(req: LLMRequest): Promise<LLMReply>
  models(): Promise<ModelInfo[]>
}

/** 名称含这些特征的视为快模型 */
const FAST_NAME = /flash|mini|haiku|lite|turbo|small|nano|instant|fast/i
/**
 * 必须排除的变体后缀：
 * - :batch   批处理端点是**异步**的，是最慢的一档（实测 OpenRouter 上有 60 个）
 * - :free    免费额度限流排队
 * - :thinking / :extended  推理档，首字延迟高
 */
const SLOW_VARIANT = /:(batch|free|thinking|extended)\b/

/**
 * 免费档整体下架（2026-08-25 实拍 429）：:free 档是**账户级**每分钟 ~20 次
 * 的限流，而这套架构一句话 = 快层 2 轮 + 慢层 1 轮 + 异步压缩，天然是请求
 * 放大器——免费档进主对话必然频繁限流，还慢（实测快层 16.5s）。纯函数，可单测
 */
export const dropFreeTier = (models: ModelInfo[]): ModelInfo[] =>
  models.filter(m => !/:free\b/.test(m.id))

/** 快速模型筛选。纯函数，可单测 */
export function pickFastModels(models: ModelInfo[]): ModelInfo[] {
  return models
    .filter(m => !SLOW_VARIANT.test(m.id))
    .filter(m => FAST_NAME.test(m.id) || FAST_NAME.test(m.name))
    .slice()
    .sort((a, b) => (a.promptPrice ?? 0) - (b.promptPrice ?? 0))
}

/**
 * 拉取失败时的兜底候选 —— 仅作下拉框初始项，真实列表运行时从 OpenRouter 拉取。
 * 2026-08 在 OpenRouter 上实测存活且支持 function calling。
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'qwen/qwen3.7-flash', name: 'Qwen3.7 Flash（最快）', tools: true, promptPrice: 3e-8 },
  { id: 'z-ai/glm-4.7-flash', name: 'GLM-4.7 Flash（快）', tools: true, promptPrice: 6e-8 },
  { id: 'openai/gpt-5-nano', name: 'GPT-5 nano（快）', tools: true, promptPrice: 5e-8 },
  { id: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash（稳）', tools: true, promptPrice: 3e-7 },
]

/**
 * OpenRouter 适配器。零后端：直接从浏览器调用。
 * Key 由控制面板注入，不写入任何交付文件。
 */
/**
 * 带联网能力的单轮问答。给 web.search 用——模型名加 `:online` 后缀，
 * OpenRouter 会先跑一次搜索（底层 Exa）再让模型作答。
 *
 * 独立于主对话：主对话常开 web 插件的话每轮都可能触发计费，而且模型会在
 * 不需要的时候搜。做成"调用时才发一次"，计费和触发时机都可控。
 */
export function createOnlineChat(getKey: () => string, getModel: () => string) {
  return async (system: string, prompt: string): Promise<string> => {
    const res = await fetch(`${api('openrouter')}/api/v1/chat/completions`, {
      method: 'POST',
      // 60s 超时：实测 :online 正常 4-30s；挂起的连接不许冻住任务（实拍几分钟没反应）
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        /**
         * 引擎显式选 Parallel Turbo（2026-08-18，接入清单里最便宜的一次优化）：
         * :online 后缀的默认引擎是 Exa（$0.007/次），Parallel Turbo $0.001，
         * 同样含 10 条结果 —— 改一个配置字段成本降 7 倍。
         */
        model: getModel(),
        plugins: [{ id: 'web', engine: 'parallel', mode: 'turbo', max_results: 6 }],
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) throw new Error(`联网搜索失败 ${res.status}: ${(await res.text()).slice(0, 120)}`)
    const json = await res.json()
    // 走 toSpeech：这段会被主 Agent 转述出去，Markdown 和思考标签都是噪音
    return toSpeech(stripThinking(json.choices?.[0]?.message?.content ?? ''))
  }
}

export function createOpenRouter(getKey: () => string, getModel: () => string,
                                 retryDelayMs: () => number = () => 1500): LLM {
  const base = `${api('openrouter')}/api/v1`

  return {
    async models(): Promise<ModelInfo[]> {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${getKey()}` },
      })
      if (!res.ok) throw new Error(`模型列表拉取失败 ${res.status}`)
      const json = await res.json()
      return (json.data ?? [])
        .filter((m: any) => (m.supported_parameters ?? []).includes('tools'))
        .map((m: any) => ({
          id: m.id,
          name: m.name ?? m.id,
          tools: true,
          contextLength: m.context_length,
          promptPrice: parseFloat(m.pricing?.prompt ?? '0'),
        }))
    },

    async chat(req: LLMRequest): Promise<LLMReply> {
      /**
       * 瞬时 429 退避重试一次——协议客户端的机制（同 per-request 超时一档），
       * 不是业务兜底：上游满载多为秒级抖动，一次 1.5s 退避能吸收大半，
       * 省得每次都把错误怼到用户脸上。连续两次 429 才如实报。
       */
      const once = () => fetch(`${base}/chat/completions`, {
        method: 'POST',
        // 120s 超时：大模型长轮正常 5-45s，悬挂连接不许冻住整个 turn
        signal: AbortSignal.timeout(120_000),
        headers: {
          Authorization: `Bearer ${getKey()}`,
          'Content-Type': 'application/json',
          'X-Title': 'Cockpit Agent Sim',
        },
        body: JSON.stringify({
          model: getModel(),
          messages: [{ role: 'system', content: req.system }, ...req.messages],
          tools: req.tools,
          tool_choice: 'auto',
          temperature: 0.3,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          // 同一模型不同 provider 延迟差几倍（实测 GLM-flash 8.6s→3.2s）。
          // 语音场景延迟就是体验，按延迟路由
          provider: { sort: 'latency' },
        }),
      })
      let res = await once()
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, retryDelayMs()))
        res = await once()
      }
      if (!res.ok) throw new Error(llmErrorText(res.status, await res.text()))
      const json = await res.json()
      const m = json.choices?.[0]?.message
      if (!m) throw new Error('模型返回为空')
      return {
        text: toSpeech(m.content) || undefined,
        toolCalls: (m.tool_calls ?? []).map((c: any) => ({
          id: c.id,
          name: c.function.name,
          args: safeParse(c.function.arguments),
        })),
      }
    },
  }
}

const safeParse = (s: string) => { try { return JSON.parse(s || '{}') } catch { return {} } }

/**
 * 清掉思考标签。推理模型有时会把思考内容（或只剩一个尾标签）混进 content，
 * 这段文字会直接被念给用户听——实测 MiniMax M3 会吐 `</mm:think>`。
 * 各家标签名不一，统一按 `<[前缀:]think>` 处理，成对与单个残留都清。
 */
export function stripThinking(text?: string): string {
  return (text ?? '')
    .replace(/<(\w+:)?think>[\s\S]*?<\/(\w+:)?think>/g, '')
    .replace(/<\/?(\w+:)?think>/g, '')
    .trim()
}

/**
 * 把模型话术清理成"能念出来的样子"。
 * 话术会直接进 TTS，Markdown 星号井号念出来全是噪音；换行在语音里也不存在。
 * Prompt 里反复交代过不要用 Markdown，模型照样用——这类硬性要求靠机制兜底更省心。
 */
export function toSpeech(text?: string): string {
  return stripThinking(text)
    // 伪工具调用残片：模型（实测 MiniMax）被撤工具后会把调用写成私有格式文本
    // （"]<]minimax[>[<tool_call>…"），整段被念给用户。从第一个标记起截断
    .replace(/(\]<\]\w*\[>\[|<tool_call\b|<invoke\b|<function_call\b)[\s\S]*$/, '')
    .replace(/\*\*|__|`/g, '')            // 加粗与代码标记
    .replace(/^\s*#{1,6}\s*/gm, '')        // 标题井号
    .replace(/^\s*[-*+]\s+/gm, '')         // 列表符号
    .replace(/\s*\n+\s*/g, ' ')            // 多行折一行
    .trim()
}
