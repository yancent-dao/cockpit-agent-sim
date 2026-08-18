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
