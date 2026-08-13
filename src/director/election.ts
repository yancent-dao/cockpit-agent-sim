/**
 * 控制面板的单写者选举 —— 纯判定，接线在 main.ts。
 *
 * 症状（用户实拍）：同时开两个控制面板，两份桌面的卡片 id 不同，
 * 轮流推送让车机屏每两秒全量拆建——卡片集体闪、播放器节点销毁重建
 * 导致音乐"重新播放"，与是否在播放无关。
 *
 * 规则：**新开的面板接管**（用户打开它就是要用它），旧的静默让位；
 * 用户在旧面板一开口（ask/场景按钮）就夺回写权。同毫秒用 src 字典序决胜，
 * 保证两边裁出同一个赢家。
 */
export interface Writer { src: string; boot: number }

export const yieldsTo = (me: Writer, other: Writer): boolean =>
  other.src !== me.src && (other.boot > me.boot || (other.boot === me.boot && other.src > me.src))
