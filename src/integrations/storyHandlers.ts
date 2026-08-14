/**
 * 「路上的故事」的机制半边 —— AI 儿童有声绘本。
 *
 * 这一层只做**机制**：存档案、画图、拼卡片、推信号、成书。
 * **决策全在模型**：每章几页（第一章 3 页、之后 2 页）、什么时候该问孩子、
 * 快到站怎么收尾 —— 全是技能包里的章法。所以页数是 Tool 参数不是这里的常量，
 * 「孩子说结束了吗」也不在这里判断（那会是关键词匹配，直接违反
 * 「代码里不许出现意图分支」）。
 *
 * ## 角色一致性靠一条架构选择
 *
 * 每一页都拿**定妆照**当参考图，**不是拿上一页**。调研里反复提到的失败模式
 * 是"累积漂移"——以上一页为参考，一页页往下画主角越画越不像，一页坏了整本重来。
 * 每页独立锚在同一个点上，误差不累积；某页画歪单页重画就行，代价 $0.04。
 */
import type { Store } from '../core/store'
import type { Desk } from '../cards/desk'
import type { StoryStore, Book, BookPage } from '../state/story'
import type { ToolResult } from '../tools/registry'

/** 模型给的一页：念的话 + 画什么 */
interface PageSpec { line: string; scene: string }

export interface ImageGen {
  generate(o: { prompt: string; refs?: string[]; aspect?: string }): Promise<{ dataUrl: string; cost: number }>
}

/** 绘本卡的 key。全局只有一本在讲，固定 key 让刷新走 render 而不是重建 */
const CARD = 'storybook'
const DEFAULT_STYLE = '扁平矢量童书插画，柔和暖色，干净背景'
/**
 * **画面里不许出现任何文字**。
 *
 * 实测（2026-08-14）：不写这条，模型会自作主张在图里印字幕，而且是**英文**
 * ——「One day, under the old stone bridge...」印在一本中文绘本的第三页上。
 * 绘本的文字是我们自己排的（要逐字点亮、要能朗读、要进导出的 H5），
 * 图里再来一份既重复又对不上，还破坏画面。
 */
const NO_TEXT = '画面中不要出现任何文字、字母、标题、字幕或水印，只画画面本身。'

export function createStoryHandlers(
  store: Store,
  desk: () => Desk | undefined,
  story: () => StoryStore,
  image: () => ImageGen,
) {
  /** 当前这本书的草稿。没讲完之前不进域仓——半本书没有留存价值 */
  let draft: { title: string; pages: BookPage[]; ideas: string[]; chapter: number
    /** 本章最后一页是第几页。车机屏靠它判断"读完这页该问孩子了" */
    chapterEnd: number } | null = null
  /**
   * 刚讲完的那本，留在内存里。**导出不该经过 localStorage** ——
   * 配额爆掉是存储的事，把交付物（家长要发给爷爷奶奶的那个 H5）
   * 一起毁掉是把两件不相干的事绑在了一起。
   */
  let finished: Book | null = null
  /** 定妆时锁死的形象不变量，每页提示词都带上它 */
  let look = ''
  let style = DEFAULT_STYLE
  /**
   * 这本书累计花了多少钱。**图像比文本贵一个量级** —— 实测 $0.068/张
   * （设计估算 $0.04 的 1.7 倍），一本 7 页约 $0.5。推进信号让面板能显示，
   * 不然跑几轮就烧掉 Key 的额度还不知道。
   */
  let spent = 0
  const bill = (usd: number) => {
    spent += usd
    store.set('story.cents', Math.round(spent * 100))
  }

  const reject = (code: string, message: string): ToolResult =>
    ({ status: 'rejected', code, message })

  /** 当前页的内容推给卡片。一张卡换版式，不是四张卡 */
  const paint = (extra: Record<string, unknown> = {}) => {
    const page = store.get('story.page') as number
    const p = draft?.pages[page - 1]
    desk()?.render({
      key: CARD, template: 'storybook', kind: 'system', urgency: 'urgent',
      ttl: 'untilDismissed',
      data: {
        /**
         * **一次性字段自己负责收尾。** `desk.update()` 的语义是合并
         * （`{...旧, ...新}`）—— 这对 ETA 每秒刷一次那种局部更新是对的，
         * 但定妆时写进去的 `photo` 一旦不显式清掉就永远活着：实拍看到
         * 故事讲到第二页，卡上还挂着孩子的原始照片、还是定妆那个并排版式。
         */
        photo: undefined,
        title: draft?.title ?? '',
        chapter: store.get('story.chapter'),
        page, total: draft?.pages.length ?? 0,
        // 章末的位置。少了它车机屏分不清"翻下一页"和"该问孩子了"
        chapterEnd: draft?.chapterEnd ?? 0,
        pending: store.get('story.pending'),
        line: p?.text ?? '', image: p?.image,
        ideas: draft?.ideas ?? [],
        ...extra,
      },
    })
  }

  /**
   * 画一页。**失败不抛** —— 断网、额度用完都会遇到，画不出图不该让整个故事停下。
   * 文字全文先落本地，图缺就缺，纯语音继续讲。
   */
  /**
   * 画幅 **1:1**（2026-08-14 两轮实拍之后定的：16:9 → 4:3 → 1:1）。
   *
   * 屏幕上是左图右文，左栏是**满高的一竖条**，在默认档（stage）上正好是方的。
   * 横画幅塞进去只有两种结局：contain 上下留白（"一点都不像画册"），
   * 或者 cover 把画面裁掉一截（"图片没有显示全"）。方图**恰好填满** ——
   * 不裁也不留白，图能直接出血到卡片边缘，那才是画册的样子。
   * 方开本本身也是童书的常见规格。
   */
  const draw = async (scene: string, aspect = '1:1'): Promise<string | undefined> => {
    const cast = story().cast()
    try {
      /**
       * **必须明说"参考图里的这个人就是主角"**（2026-08-14 真实跑通后修）。
       *
       * 第一版的提示词是「画风。场景。主角形象保持一致：短发黄裙…」——
       * 从没说过参考图和主角的关系，模型就把它当**画风参考**用了：
       * 实拍两页彼此一致，但都跟定妆照对不上（定妆是棕色短发白鞋，
       * 正文出来长黑发黄鞋）。角色一致性是这个产品的命根子，
       * 参考图只当画风用等于这条价值没落地。
       *
       * 顺序也调了：**主角在最前**，场景其次，画风最后。
       * 放最后的约束在长提示词里容易被稀释。
       */
      const who = cast
        ? `参考图里的这个小女孩就是主角，保持她的长相、发型、发色、衣着、鞋子完全一致。`
        : `主角：${look}。`
      const r = await image().generate({
        prompt: `${who}画面内容：${scene}。形象要点复核：${look}。整体画风：${style}。${NO_TEXT}`,
        refs: cast ? [cast] : undefined,
        aspect,
      })
      bill(r.cost)
      return r.dataUrl
    } catch { return undefined }
  }

  /**
   * 一章的图**边讲边补**：先把文字全部落进草稿并立刻上卡（用户 2 秒内就能开讲），
   * 图片补回去。`story.pending` 让进度点里的虚线圈动起来 ——
   * "故事一边讲一边长"这件事必须让人看见，否则用户以为卡住了。
   *
   * **一章之内并发**（2026-08-14 真跑之后改）。实测一张 9–10 秒，串行的话
   * 第一章 3 页要 30 秒才齐；而一句童书正文念出来只要 6–8 秒，讲到第二页
   * 图还没到，`afterRead` 就把节奏卡住，孩子对着空画框等。并发之后三张
   * ~10 秒一起到，钱一分不多花。并发上限是这一章的页数（2–3 张），不是无限。
   *
   * 落位认**下标**不认完成顺序 —— 谁先画完是不确定的，认顺序就会错页。
   */
  const fillImages = async (from: number, specs: PageSpec[]) => {
    let left = specs.length
    store.set('story.pending', left)
    await Promise.all(specs.map(async (s, i) => {
      const url = await draw(s.scene)
      if (draft?.pages[from + i]) draft.pages[from + i].image = url
      store.set('story.pending', --left)
      paint()
    }))
  }

  const addChapter = async (specs: PageSpec[]) => {
    const from = draft!.pages.length
    draft!.pages.push(...specs.map(s => ({ text: s.line })))
    draft!.chapterEnd = draft!.pages.length
    draft!.chapter += 1
    store.set('story.chapter', draft!.chapter)
    store.set('story.page', from + 1)
    store.set('story.phase', 'telling')
    paint()
    /**
     * **不 await**。实测一章两页要 22 秒（每张 11 秒串行），而设计是
     * "文字先出（约 2 秒）立刻开讲，图片后台流式补齐" —— 等图画完再返回，
     * 用户就是干等 22 秒看着空屏。
     *
     * 节奏由车机屏那边的 `afterRead` 接住：`story.pending > 0` 时它返回 `wait`，
     * 让画面追上声音再翻页。图挂了也不影响 —— `draw()` 本来就吞异常。
     */
    void fillImages(from, specs)
  }

  return {
    storyProfile: async (a: any): Promise<ToolResult> => {
      story().saveProfile({ name: a?.name, age: a?.age, interests: a?.interests, lesson: a?.lesson })
      return { status: 'ok', message: `记住了，${a?.name ?? '孩子'}的档案存好了` }
    },

    /**
     * 定妆 —— 全书唯一需要家长把关的一步。
     * 授权闸在这里而不是在 UI：儿童影像是最敏感的一类数据，
     * 任何一条通往"把照片发出去"的路径都得过同一个闸。
     */
    storyCast: async (a: any): Promise<ToolResult> => {
      const s = story()
      if (!s.consented())
        return reject('NEED_CONSENT', '照片要发给画图的模型才能生成主角，得先请家长在控制面板上点头同意')
      const photo = s.photo()
      if (!photo)
        return reject('NO_PHOTO', '还没有孩子的照片——把图放进 public/hero/，或者在控制面板上传一张')

      look = String(a?.look ?? '')
      style = String(a?.style || DEFAULT_STYLE)
      let url: string
      try {
        const r = await image().generate({
          prompt: `${style}。为这个孩子画一张动漫版定妆立绘，正面、全身、表情友好。形象要点：${look}。${NO_TEXT}`,
          refs: [photo], aspect: '1:1',
        })
        bill(r.cost)
        url = r.dataUrl
      } catch (e: any) {
        return reject(e?.code ?? 'DRAW_FAILED', e?.message ?? '这次没画出来，再试一次看看')
      }
      s.saveCast(url)
      store.set('story.phase', 'cast')
      desk()?.render({
        key: CARD, template: 'storybook', kind: 'system', urgency: 'urgent', ttl: 'untilDismissed',
        data: { title: '这是故事里的主角', line: '像吗？不像的话我再画一张', photo, image: url, page: 0, total: 0 },
      })
      return { status: 'ok', message: '主角画好了，给家长看看像不像', data: { cost: spent } }
    },

    storyBegin: async (a: any): Promise<ToolResult> => {
      if (!story().cast()) return reject('NO_CAST', '还没给主角定妆，先调 story.cast 画一张')
      const specs: PageSpec[] = a?.pages ?? []
      draft = { title: String(a?.title ?? '我们的故事'), pages: [], ideas: [], chapter: 0, chapterEnd: 0 }
      store.set('story.active', true)
      await addChapter(specs)
      return { status: 'ok', message: `《${draft.title}》开讲了`, data: { pages: specs.length, cost: spent } }
    },

    storyContinue: async (a: any): Promise<ToolResult> => {
      if (!draft) return reject('NO_STORY', '还没有正在讲的故事，先调 story.begin 开一本')
      // 孩子说的话是**书的一等字段**，不是从正文里事后猜的——封底要单列出来
      if (a?.idea) draft.ideas.push(String(a.idea))
      await addChapter(a?.pages ?? [])
      return { status: 'ok', message: '接着往下讲了', data: { cost: spent } }
    },

    storyFinish: async (a: any): Promise<ToolResult> => {
      if (!draft) return reject('NO_STORY', '还没有正在讲的故事')
      const end = String(a?.ending ?? '')
      if (end) {
        draft.pages.push({ text: end })
        store.set('story.page', draft.pages.length)
        if (a?.scene) draft.pages[draft.pages.length - 1].image = await draw(String(a.scene))
      }
      const book: Book = {
        title: draft.title, createdAt: Date.now(),
        pages: draft.pages, ideas: draft.ideas,
        trip: String(store.get('navigation.destination') || ''),
      }
      /**
       * **存不下必须说出来**。域仓有降级阶梯（图文 → 只剩文字 → 存不下），
       * 结果得走进模型的上下文 —— 不然用户听到"讲完了"，转头点导出拿到的是
       * 上一本书，或者干脆没有。交付物没了还没人知道，是最坏的一种失败。
       * 顺利存下时一个字都不提，别拿实现细节烦用户。
       */
      const kept = story().saveBook(book)
      finished = book
      const note = kept === 'text' ? '，不过手机存不下这么多图，只留住了文字'
        : kept === 'failed' ? '，不过这本没能存下来，想留着就现在导出' : ''
      store.set('story.phase', 'done')
      store.set('story.active', false)
      store.set('story.pending', 0)
      paint({ done: true })
      return { status: 'ok', message: `《${book.title}》讲完了，${book.pages.length} 页${note}`, data: { cost: spent } }
    },

    /** 翻页：屏幕按钮直调，不叫醒模型。翻到头停住，不绕回也不报错 */
    storyPage: async (a: any): Promise<ToolResult> => {
      if (!draft) return reject('NO_STORY', '现在没有在讲的故事')
      const cur = store.get('story.page') as number
      const dir = String(a?.dir ?? 'next')
      const next = dir === 'prev' ? Math.max(1, cur - 1)
        : dir === 'next' ? Math.min(draft.pages.length, cur + 1)
        : cur
      store.set('story.page', next)
      paint()
      return { status: 'ok', data: { page: next } }
    },

    storyExport: async (): Promise<ToolResult> => {
      // 内存里那本优先 —— 存储存不下时它是唯一还在的副本
      const b = finished ?? story().books()[0]
      if (!b) return reject('NO_BOOK', '还没有讲完的书可以导出')
      return { status: 'ok', message: `《${b.title}》可以导出了`, data: { book: b } }
    },
  }
}
