/**
 * 段内通配匹配。`*` 只在单个路径段内展开，不跨 `.`
 *   cabin.window.*.position      → 匹配四扇窗
 *   cabin.window.rear*.position  → 只匹配 rearLeft / rearRight
 */
const cache = new Map<string, RegExp>()

export function globMatch(pattern: string, path: string): boolean {
  if (pattern === '*') return true          // 单独的 * 表示全部（跨段）
  let re = cache.get(pattern)
  if (!re) {
    const src = '^' + pattern
      .split('')
      .map(c => (c === '*' ? '[^.]*' : c === '.' ? '\\.' : c.replace(/[|\\{}()[\]^$+?]/g, '\\$&')))
      .join('') + '$'
    re = new RegExp(src)
    cache.set(pattern, re)
  }
  return re.test(path)
}
