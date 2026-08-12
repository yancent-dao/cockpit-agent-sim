import { describe, it, expect } from 'vitest'
import { sanitize } from '../../src/screen/sanitize'

const clean = (html: string) => sanitize(html).html

/**
 * 生成式卡让模型**直出 HTML**。这是本次重设计里唯一一处
 * 「把模型输出当代码执行」的地方 —— 消毒器是安全边界，不是可选项。
 *
 * 下面七条是必测攻击面。少一条都不能算做完。
 */
describe('七条攻击用例', () => {
  it('① <script> 整个剥掉，内容也不留', () => {
    const h = clean('<div>正常<script>alert(1)</script></div>')
    expect(h).not.toContain('script')
    expect(h).not.toContain('alert')
    expect(h).toContain('正常')
  })

  it('② onerror / onclick 这类事件属性一律剥离', () => {
    const h = clean('<img src="https://a/b.png" onerror="alert(1)"><div onclick="x()">x</div>')
    expect(h).not.toMatch(/onerror|onclick/i)
    expect(h).toContain('https://a/b.png')
  })

  it('③ javascript: 协议的 href / src 不放行', () => {
    const h = clean('<a href="javascript:alert(1)">点</a><img src="javascript:alert(1)">')
    expect(h).not.toContain('javascript:')
  })

  it('④ style 里的 url() 剥掉 —— 它能发外部请求', () => {
    const h = clean('<div style="background:url(https://evil/x.png);color:red">x</div>')
    expect(h).not.toContain('url(')
    expect(h).toContain('color:red')   // 正常声明留着
  })

  it('⑤ <iframe> / <object> / <embed> 一个不留', () => {
    for (const t of ['iframe', 'object', 'embed'])
      expect(clean(`<${t} src="https://evil"></${t}>`), t).not.toContain(t)
  })

  it('⑥ SVG 里夹带的 script 同样剥掉 —— SVG 是脚本载体的老路子', () => {
    const h = clean('<svg><circle cx="5" cy="5" r="4"/><script>alert(1)</script></svg>')
    expect(h).not.toContain('script')
    expect(h).toContain('circle')      // 合法 SVG 元素留着
  })

  it('⑦ data:text/html 不放行，data:image/ 放行', () => {
    expect(clean('<img src="data:text/html;base64,PHNjcmlwdD4=">')).not.toContain('data:text/html')
    expect(clean('<img src="data:image/png;base64,iVBOR">')).toContain('data:image/png')
  })
})

describe('其它必须挡住的', () => {
  it('<style> 不放行 —— 模型能写出影响 :host 的选择器', () => {
    expect(clean('<style>:host{position:fixed}</style><p>x</p>')).not.toContain('style>')
  })

  it('form / input / button 不放行 —— 屏幕不可交互，出现表单是骗人', () => {
    for (const t of ['form', 'input', 'button', 'select', 'textarea'])
      expect(clean(`<${t}></${t}>`), t).not.toContain(`<${t}`)
  })

  it('position:fixed 剥掉 —— 它能逃出卡片盖住整屏', () => {
    expect(clean('<div style="position:fixed;top:0">x</div>')).not.toContain('fixed')
  })

  it('@import 剥掉', () => {
    expect(clean('<div style="@import url(x)">y</div>')).not.toContain('@import')
  })

  it('xlink:href 剥掉 —— SVG 里的老式外链', () => {
    expect(clean('<svg><use xlink:href="https://evil#x"/></svg>')).not.toContain('xlink')
  })
})

describe('合法内容要完整留下，否则模型会觉得这个模板不能用', () => {
  it('排版标签放行', () => {
    const h = clean('<div class="a"><h4>标题</h4><p>正文<b>粗</b><small>小</small></p>' +
      '<ul><li>甲</li><li>乙</li></ul></div>')
    for (const s of ['h4', '标题', '<b>', '<ul>', '甲']) expect(h, s).toContain(s)
  })

  it('表格放行 —— 对比类内容离不开它', () => {
    const h = clean('<table><thead><tr><th>路线</th></tr></thead><tbody><tr><td>快</td></tr></tbody></table>')
    for (const s of ['table', 'thead', '<th>', '路线']) expect(h, s).toContain(s)
  })

  it('SVG 全族放行，图表才画得出来', () => {
    const h = clean('<svg viewBox="0 0 10 10"><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
      '<path d="M0 0L9 9" stroke="#000" stroke-width="2"/><text x="1" y="2">甲</text></svg>')
    for (const s of ['viewBox', 'linearGradient', 'stop-color', 'd="M0 0L9 9"', '<text']) expect(h, s).toContain(s)
  })

  it('闭合标签要写全 —— </div> 不能变成 </>', () => {
    const h = clean('<div><p>甲</p><b>乙</b></div>')
    expect(h).toBe('<div><p>甲</p><b>乙</b></div>')
  })

  it('少写的闭合标签自动补上，不让后面的内容被吃进去', () => {
    expect(clean('<div><p>甲')).toBe('<div><p>甲</p></div>')
  })

  it('多余的闭合标签直接吃掉，不产生野生 </p>', () => {
    expect(clean('甲</p></div>')).toBe('甲')
  })

  it('嵌套乱序时按最近的开标签配对，不越界', () => {
    expect(clean('<div><b>甲</div></b>')).toBe('<div><b>甲</b></div>')
  })

  it('SVG 的大小写要还原 —— 写成 viewbox / lineargradient 就不渲染了', () => {
    const h = clean('<svg viewBox="0 0 1 1"><defs><linearGradient id="g"/></defs></svg>')
    expect(h).toContain('viewBox=')
    expect(h).toContain('<linearGradient')
    expect(h).not.toContain('viewbox=')
  })

  it('inline style 的正常声明保留', () => {
    expect(clean('<div style="display:flex;gap:8px">x</div>')).toContain('display:flex')
  })
})

/**
 * 消毒后为空必须退回 generic 渲染 text，**绝不白屏**。
 * 模型写了一整屏 <script> 时，用户看到的应该是那句话，不是一张空卡。
 */
describe('消毒后为空要能退回', () => {
  it('全被剥光时 empty 为 true', () => {
    expect(sanitize('<script>alert(1)</script>').empty).toBe(true)
    expect(sanitize('').empty).toBe(true)
    expect(sanitize('   ').empty).toBe(true)
  })

  it('留下了内容就不算空', () => {
    expect(sanitize('<p>还有话说</p>').empty).toBe(false)
  })

  // 空白标签壳子（<div></div>）也算空——它渲染出来就是一张白卡
  it('只剩空壳子也算空', () => {
    expect(sanitize('<div><span></span></div>').empty).toBe(true)
  })
})

/** 剥了什么要说出来，否则调不动：模型不知道自己哪里写错了 */
describe('剥离记录进 trace', () => {
  it('报出被剥的标签名', () => {
    expect(sanitize('<script></script><iframe></iframe>').stripped).toEqual(
      expect.arrayContaining(['script', 'iframe']))
  })

  it('报出被剥的属性名', () => {
    expect(sanitize('<div onclick="x">y</div>').stripped).toEqual(
      expect.arrayContaining(['@onclick']))
  })

  it('干净的内容不产生记录', () => {
    expect(sanitize('<p>好好写的</p>').stripped).toEqual([])
  })
})
