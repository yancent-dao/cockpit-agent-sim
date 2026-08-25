import { describe, it, expect } from 'vitest'
import { llmErrorText } from '../../src/agent/llm'

/**
 * 模型调用失败的人话化（2026-08-18 实拍：慢层撞锁区模型，
 * 「模型调用失败 403: {"error":{"message":"This model is not available
 * in your region."...}}」一坨英文 JSON 原样蹦给用户）。
 * 原则 4：message 写人话不写日志——它会进播报、进 trace、进用户眼睛。
 */

describe('llmErrorText', () => {
  it('403 锁区：说清是网络出口的事，给两条出路', () => {
    const t = llmErrorText(403, '{"error":{"message":"This model is not available in your region.","code":403}}')
    expect(t).toContain('地区')
    expect(t).toMatch(/换.*模型/)
    expect(t).toContain('代理')
    expect(t).not.toContain('{')   // 不许把 JSON 带出来
  })

  it('401：Key 不对', () => {
    expect(llmErrorText(401, 'x')).toContain('Key')
  })

  it('402/429：额度或限流', () => {
    expect(llmErrorText(402, 'x')).toContain('额度')
    expect(llmErrorText(429, 'x')).toMatch(/频繁|限流|稍/)
  })

  it('5xx：上游故障，建议稍后再试', () => {
    expect(llmErrorText(502, 'x')).toMatch(/稍后|再试/)
  })

  it('未知状态码兜底也不泄 JSON', () => {
    const t = llmErrorText(418, '{"weird":true}')
    expect(t).not.toContain('{')
    expect(t).toContain('418')
  })
})

describe('429 要分清是谁在限（2026-08-25 实拍：钱够、免费档也下架了还在 429——上游 provider 满载被翻译成"请求太频繁"，用户以为是自己的问题）', () => {
  it('上游 provider 满载：点名服务商，说清不是账户问题', () => {
    const t = llmErrorText(429, '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen is rate limited upstream","provider_name":"Alibaba"}}}')
    expect(t).toContain('Alibaba')
    expect(t).toMatch(/上游|提供方|服务商/)
    expect(t).toMatch(/换.*模型|稍等/)
    expect(t).not.toContain('{')
  })

  it('账户级限流（免费档口径）：说清是账户每分钟的配额', () => {
    const t = llmErrorText(429, '{"error":{"message":"Rate limit exceeded: free-models-per-min"}}')
    expect(t).toMatch(/免费|账户/)
  })

  it('看不出原因的 429 保持原话术', () => {
    expect(llmErrorText(429, '')).toMatch(/频繁|限流/)
  })
})

describe('瞬时 429 自动退避重试一次——协议客户端的机制，不是业务兜底', () => {
  it('第一次 429 第二次 200：调用方无感拿到结果', async () => {
    const { createOpenRouter } = await import('../../src/agent/llm')
    let n = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).includes('/chat/completions')) {
        n++
        if (n === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), { status: 200 })
      }
      return orig(url, init)
    }) as any
    try {
      const llm = createOpenRouter(() => 'k', () => 'm', () => 0)   // 退避 0ms，测试不真等
      const r = await llm.chat({ system: 's', messages: [], tools: [] })
      expect(r.text).toBe('好')
      expect(n).toBe(2)
    } finally { globalThis.fetch = orig }
  })

  it('连续两次 429 才报错——报的还是人话', async () => {
    const { createOpenRouter } = await import('../../src/agent/llm')
    let n = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/chat/completions')) { n++; return new Response('{"error":{"message":"rate limited"}}', { status: 429 }) }
      return orig(url as any)
    }) as any
    try {
      const llm = createOpenRouter(() => 'k', () => 'm', () => 0)
      await expect(llm.chat({ system: 's', messages: [], tools: [] })).rejects.toThrow(/限流|频繁/)
      expect(n).toBe(2)
    } finally { globalThis.fetch = orig }
  })
})

describe('主对话关推理（2026-08-25 实拍：deepseek-v4-flash 名字带 flash 其实是推理模型，话术轮 maxTokens 全被思考吃掉，content 空 →「无话术」）', () => {
  const mkFetch = (handler: (body: any, n: number) => Response) => {
    let n = 0
    return (async (url: any, init?: any) => {
      if (String(url).includes('/chat/completions')) { n++; return handler(JSON.parse(init.body), n) }
      throw new Error('unexpected ' + url)
    }) as any
  }
  const OK = new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), { status: 200 })

  it('默认请求带 reasoning.enabled=false——语音场景延迟就是体验，不要思考', async () => {
    const { createOpenRouter } = await import('../../src/agent/llm')
    const orig = globalThis.fetch
    let seen: any
    globalThis.fetch = mkFetch(body => { seen = body; return OK.clone() })
    try {
      await createOpenRouter(() => 'k', () => 'm', () => 0).chat({ system: 's', messages: [], tools: [] })
      expect(seen.reasoning).toEqual({ enabled: false })
    } finally { globalThis.fetch = orig }
  })

  it('模型说 reasoning mandatory（gemini 类 400）→ 换 effort:minimal 重发，同模型第二次直接用 effort', async () => {
    const { createOpenRouter } = await import('../../src/agent/llm')
    const orig = globalThis.fetch
    const bodies: any[] = []
    globalThis.fetch = mkFetch(body => {
      bodies.push(body.reasoning)
      return body.reasoning?.enabled === false
        ? new Response('{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled"}}', { status: 400 })
        : OK.clone()
    })
    try {
      const llm = createOpenRouter(() => 'k', () => 'g', () => 0)
      const r1 = await llm.chat({ system: 's', messages: [], tools: [] })
      expect(r1.text).toBe('好')
      const r2 = await llm.chat({ system: 's', messages: [], tools: [] })
      expect(r2.text).toBe('好')
      // 第一次：off → 400 → effort；第二次：记住了，直接 effort，单请求
      expect(bodies).toEqual([{ enabled: false }, { effort: 'minimal' }, { effort: 'minimal' }])
    } finally { globalThis.fetch = orig }
  })

  it('别的 400 不重发，照常人话报错', async () => {
    const { createOpenRouter } = await import('../../src/agent/llm')
    const orig = globalThis.fetch
    let n = 0
    globalThis.fetch = mkFetch(() => { n++; return new Response('{"error":{"message":"bad request"}}', { status: 400 }) })
    try {
      await expect(createOpenRouter(() => 'k', () => 'm', () => 0).chat({ system: 's', messages: [], tools: [] }))
        .rejects.toThrow()
      expect(n).toBe(1)
    } finally { globalThis.fetch = orig }
  })
})
