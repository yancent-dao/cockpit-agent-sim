import { describe, it, expect } from 'vitest'
import { buildBookHtml, bookFileName } from '../../src/integrations/h5book'
import type { Book } from '../../src/state/story'

/**
 * ══════════ 导出的 H5：这个产品真正的交付物 ══════════
 *
 * 车上的体验是过程，**H5 是留下来的东西** —— 家长会把它发给爷爷奶奶。
 * 技术上是一个自包含单文件：图片全部 base64 内嵌，双击就能打开，
 * 不用网、不用我们的服务器。零依赖。
 */

const book = (o: Partial<Book> = {}): Book => ({
  title: '妞妞和小熊的雨天',
  createdAt: new Date('2026-08-14T10:00:00Z').getTime(),
  pages: [
    { text: '小雨点打在桥上', image: 'data:image/webp;base64,AAA' },
    { text: '小熊躲进了伞下', image: 'data:image/webp;base64,BBB' },
  ],
  ideas: ['会飞的自行车', '会说话的路灯'],
  ...o,
})

const html = (o?: Partial<Book>, extra?: any) => buildBookHtml(book(o), extra)

describe('自包含：双击就能开', () => {
  it('是一个完整的 HTML 文档', () => {
    const h = html()
    expect(h).toMatch(/^<!doctype html>/i)
    expect(h).toContain('</html>')
  })

  /** 有任何外链就意味着断网打不开、或者哪天链接挂了整本书就没了 */
  it('不引用任何外部资源', () => {
    const h = html()
    expect(h, '不许有外链脚本').not.toMatch(/<script[^>]+src=/i)
    expect(h, '不许有外链样式').not.toMatch(/<link[^>]+stylesheet/i)
    expect(h, '图片必须内嵌').not.toMatch(/<img[^>]+src=["']https?:/i)
  })

  it('图片原样内嵌，不丢', () => {
    const h = html()
    expect(h).toContain('data:image/webp;base64,AAA')
    expect(h).toContain('data:image/webp;base64,BBB')
  })
})

describe('封面', () => {
  it('书名和孩子的名字都在', () => {
    expect(html({}, { name: '妞妞', age: 5 })).toContain('妞妞和小熊的雨天')
    expect(html({}, { name: '妞妞', age: 5 })).toContain('妞妞')
  })

  it('用定妆照当封面图', () => {
    expect(html({}, { cast: 'data:image/png;base64,CAST' })).toContain('data:image/png;base64,CAST')
  })

  it('写清楚是什么时候写的', () => {
    expect(html()).toMatch(/2026/)
  })
})

describe('封底：这本书里有他写的部分', () => {
  /**
   * **整个产品最该被记住的一秒钟。** 把孩子贡献的点子单列出来，
   * 让他看见这本书里有他写的部分 —— 比任何一张插图都重要。
   */
  it('孩子想出来的点子单列一行', () => {
    const h = html()
    expect(h).toContain('会飞的自行车')
    expect(h).toContain('会说话的路灯')
  })

  it('没有点子时不留一个空标题', () => {
    const h = html({ ideas: [] })
    expect(h).not.toMatch(/想出来的[^<]*<\/[^>]+>\s*<\/(div|section)>/)
  })

  it('在去哪的路上写的也记一笔', () => {
    expect(html({ trip: '外婆家' })).toContain('外婆家')
  })
})

describe('翻页与朗读', () => {
  it('每一页都在，顺序不乱', () => {
    const h = html()
    expect(h.indexOf('小雨点打在桥上')).toBeLessThan(h.indexOf('小熊躲进了伞下'))
  })

  it('带翻页脚本 —— 左右滑、点两边、键盘都行', () => {
    const h = html()
    expect(h).toMatch(/touchstart|touchend/)
    expect(h).toMatch(/ArrowRight|keydown/)
  })

  /**
   * 朗读用浏览器原生 `SpeechSynthesis` —— 零依赖零成本，
   * 而且它有 `onboundary` 能做逐字点亮（第三方 TTS 多数反而不给这个时间戳）。
   */
  it('带朗读，用浏览器原生', () => {
    expect(html()).toContain('speechSynthesis')
  })
})

describe('安全：书里的文字是模型生成的，一样要消毒', () => {
  it('文字里的尖括号被转义，不会变成标签', () => {
    const h = buildBookHtml(book({ pages: [{ text: '<img src=x onerror=alert(1)>' }] }))
    expect(h).not.toContain('<img src=x onerror')
    expect(h).toContain('&lt;img')
  })

  it('书名里的引号不会撑破属性', () => {
    const h = buildBookHtml(book({ title: '她说"你好"<b>' }))
    expect(h).not.toContain('<b>')
  })

  it('点子里的脚本也转义', () => {
    const h = buildBookHtml(book({ ideas: ['<script>x</script>'] }))
    expect(h).not.toMatch(/<script>x<\/script>/)
  })
})

describe('文件名', () => {
  it('用书名，带日期，好认', () => {
    const n = bookFileName(book())
    expect(n).toContain('妞妞和小熊的雨天')
    expect(n).toMatch(/\.html$/)
  })

  /** 路径分隔符和冒号进文件名在某些系统上直接存不下来 */
  it('剔掉文件名里不能有的字符', () => {
    expect(bookFileName(book({ title: 'a/b:c*d?e' }))).not.toMatch(/[/:*?"<>|]/)
  })
})

describe('体积', () => {
  /**
   * 7 页 base64 图，不压的话一本 8–10MB，微信发不出去。
   * 压缩在调用方（canvas 转 webp、长边限 1280），这一层只保证
   * **不额外膨胀** —— 别把同一张图重复内嵌两遍。
   */
  it('同一张图只内嵌一次', () => {
    const same = 'data:image/webp;base64,SAME'
    const h = buildBookHtml(book({
      pages: [{ text: 'a', image: same }, { text: 'b', image: same }],
    }))
    expect(h.split('SAME').length - 1, '重复内嵌会让体积翻倍').toBe(1)
  })

  it('缺图的页照样出，不是空白', () => {
    const h = buildBookHtml(book({ pages: [{ text: '没画出来的一页' }] }))
    expect(h).toContain('没画出来的一页')
  })
})
