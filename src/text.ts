/** HTML 转义的唯一实现。此前散了 4 份（render/screen main/director/canvas 内联） */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

/**
 * 逆地理全称截短："四川省成都市青羊区" → "成都市青羊区"。
 * 卡片标题放不下三级行政区全称（用户实拍），去掉省/自治区前缀即可，
 * 市+区已经足够定位且不歧义。
 */
export const shortPlace = (name: string) =>
  String(name ?? '').replace(/^.{2,8}?(省|自治区)/, '')
