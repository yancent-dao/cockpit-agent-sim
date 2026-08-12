/** HTML 转义的唯一实现。此前散了 4 份（render/screen main/director/canvas 内联） */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
