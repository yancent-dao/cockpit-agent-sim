/**
 * 绘本域仓 —— 记忆系统的第三级（瞬时=信号 / 会话 / **领域** / 长期）。
 *
 * 孩子档案、原始照片、定妆照、成书历史。它们不是车辆状态（信号 store 对齐 VSS，
 * 那条界线不划清车速转速都会往里挤），也不是会话记忆 —— 它们是
 * "下次上车接着讲"和"再讲一个妞妞的故事"能成立的地基。
 *
 * 存储可注入（测试传假的，浏览器传 localStorage），沿用媒体域仓和 clock 的先例。
 *
 * ## 为什么档案要存下来
 *
 * 家长不该每次填表。一次录入形象、昵称、年龄、教育目标，之后每次只说一句
 * 「给妞妞讲个关于分享的故事」。教育目标才是家长真正在意的东西 ——
 * 分享、勇敢、刷牙、不怕黑、**交通安全**（最后这个在车里讲，场景绝配）。
 */
import type { DomainStorage } from './domain'

export interface ChildProfile {
  name?: string
  age?: number
  /** 兴趣：小熊、恐龙、下雨天……写进提示词让故事贴着孩子来 */
  interests?: string[]
  /** 这次想讲明白的道理。家长真正在意的字段 */
  lesson?: string
}

export interface BookPage {
  text: string
  /** data: URL。没画出来时缺省 —— 文字先出、图片后到是设计里的正常状态 */
  image?: string
}

export interface Book {
  title: string
  createdAt: number
  pages: BookPage[]
  /**
   * 孩子贡献的点子。**书的一等字段**，不是事后从正文里猜出来的 ——
   * 导出的 H5 封底要单列一行「妞妞想出来的：会飞的自行车 · 会说话的路灯」，
   * 让他看见这本书里有他写的部分。这是整个产品最该被记住的一秒钟。
   */
  ideas: string[]
  /** 在去哪的路上写的。封底那句"和爸爸在去外婆家的路上一起写的"要用 */
  trip?: string
}

const K = {
  profile: 'cockpit-sim:story:profile',
  photo: 'cockpit-sim:story:photo',
  cast: 'cockpit-sim:story:cast',
  consent: 'cockpit-sim:story:consent',
  books: 'cockpit-sim:story:books',
} as const

/**
 * 留最近几本。每本带 7 页 base64 图，一本一两 MB，而 localStorage 通常
 * 只有 5–10MB —— 不设上限的话第三本就写不进去，**而且写失败是静默的**，
 * 用户会以为存上了。
 */
const BOOK_CAP = 5

export function createStoryStore(storage: DomainStorage) {
  /** 存储里可能是坏数据（手改过、版本变过）。当没有，别把整个功能带崩 */
  const read = <T>(k: string, fallback: T): T => {
    try {
      const raw = storage.get(k)
      return raw ? JSON.parse(raw) as T : fallback
    } catch { return fallback }
  }
  /** 写失败不抛：讲了一路的故事不该因为存不下而报错给用户 */
  const write = (k: string, v: unknown) => {
    try { storage.set(k, JSON.stringify(v)) } catch { /* 配额满了就算了 */ }
  }

  return {
    profile: () => read<ChildProfile | null>(K.profile, null),
    /** 合并不覆盖 —— 只改教育目标不该把名字和兴趣一起丢了 */
    saveProfile(p: ChildProfile) {
      write(K.profile, { ...(read<ChildProfile | null>(K.profile, null) ?? {}), ...p })
    },

    /** 家长给的原始照片。跟定妆照分开存：要能对照"像不像"，也要能重新定妆 */
    photo: () => read<string | null>(K.photo, null),
    savePhoto: (dataUrl: string) => write(K.photo, dataUrl),

    /**
     * 定妆照 —— **全书每一页的锚**。
     *
     * 角色一致性靠它：之后每页都拿这张当参考图，**不是拿上一页**。
     * 每页独立锚在同一个点上，误差不累积；某页画歪了单页重画就行，
     * 不用整本重来（调研里"累积漂移"的失败模式就是以上一页为参考）。
     * 只存一张，家长说"换一个"就覆盖 —— 不做历史版本。
     */
    cast: () => read<string | null>(K.cast, null),
    saveCast: (dataUrl: string) => write(K.cast, dataUrl),

    /**
     * 儿童影像是最敏感的一类数据。照片不存我们这（没有后端），
     * 但**会发给第三方模型**做生成 —— 这件事必须是家长点过头的一次性明确动作，
     * 不是埋在设置里的默认开关。
     */
    consented: () => read<boolean>(K.consent, false) === true,
    consent: () => write(K.consent, true),
    /** 撤回时连照片和定妆照一起清。只关开关等于没撤回 */
    revoke() {
      write(K.consent, false)
      write(K.photo, null)
      write(K.cast, null)
    },

    /** 最新的排最前 —— 孩子想接着讲的多半是刚才那本 */
    books: () => read<Book[]>(K.books, [])
      .slice().sort((a, b) => b.createdAt - a.createdAt),
    saveBook(b: Book) {
      const all = [...read<Book[]>(K.books, []), b]
        .sort((x, y) => y.createdAt - x.createdAt)
        .slice(0, BOOK_CAP)
      write(K.books, all)
    },
  }
}

export type StoryStore = ReturnType<typeof createStoryStore>
