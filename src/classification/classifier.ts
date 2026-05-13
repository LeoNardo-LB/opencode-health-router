import type { Classification, ClassificationRule } from "../types.js"

// ═══ 内置规则（始终生效，用户规则会优先匹配）═══
const BUILTIN_RULES: ClassificationRule[] = [
  // 状态码 → category
  { statusCodes: [429], patterns: [], category: "rate_limit" },
  { statusCodes: [402], patterns: [], category: "quota_exceeded" },
  { statusCodes: [500, 502, 503, 504], patterns: [], category: "5xx" },
  { statusCodes: [529], patterns: [], category: "overloaded" },
  // Pattern → category（% 通配符：%word%→包含, word%→开头, %word→结尾）
  // ─── rate_limit（频率限制 / 配额耗尽）───
  { statusCodes: [], patterns: ["%已达到%使用上限%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%已达上限%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%访问量过大%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%稍后再试%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%请求过于频繁%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%请求次数%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%rate limit%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%too many requests%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%frequency%"], category: "rate_limit" },
  // ─── overloaded（过载）───
  { statusCodes: [], patterns: ["%overloaded%"], category: "overloaded" },
  { statusCodes: [], patterns: ["%capacity%"], category: "overloaded" },
  { statusCodes: [], patterns: ["%busy%"], category: "overloaded" },
  // ─── quota_exceeded（配额耗尽）───
  { statusCodes: [], patterns: ["%已用尽%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%call quota%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%insufficient_quota%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%quota exceeded%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%配额%"], category: "quota_exceeded" },
  // ─── timeout（超时）───
  { statusCodes: [], patterns: ["%timeout%"], category: "timeout" },
  { statusCodes: [], patterns: ["%timed out%"], category: "timeout" },
  // ─── network（网络 / 连接错误）───
  { statusCodes: [], patterns: ["%cannot connect%"], category: "timeout" },
  { statusCodes: [], patterns: ["%connection refused%"], category: "timeout" },
  { statusCodes: [], patterns: ["%connection reset%"], category: "timeout" },
  { statusCodes: [], patterns: ["%no route to host%"], category: "timeout" },
  { statusCodes: [], patterns: ["%network%error%"], category: "timeout" },
  { statusCodes: [], patterns: ["%dns%"], category: "timeout" },
  { statusCodes: [], patterns: ["%econnrefused%"], category: "timeout" },
  { statusCodes: [], patterns: ["%econnreset%"], category: "timeout" },
  { statusCodes: [], patterns: ["%enetunreach%"], category: "timeout" },
  { statusCodes: [], patterns: ["%etimedout%"], category: "timeout" },
  { statusCodes: [], patterns: ["%socked hang up%"], category: "timeout" },
]

const STATUS_PREFIX = /^(\d{3})/

function extractStatusCode(message: string): number | undefined {
  const match = STATUS_PREFIX.exec(message)
  return match ? parseInt(match[1], 10) : undefined
}

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 将 SQL 风格 % 通配符转换为正则并测试。
 *  不含 % 时回退到 includes 匹配（向后兼容）。*/
function matchPattern(pattern: string, text: string): boolean {
  if (!pattern.includes("%")) {
    return text.includes(pattern)
  }
  const parts = pattern.split("%").map((p) => escapeRegex(p))
  const regex = new RegExp("^" + parts.join(".*") + "$", "i")
  return regex.test(text)
}

export function classify(message: string, userRules: ClassificationRule[]): Classification | null {
  const statusCode = extractStatusCode(message)
  const lower = message.toLowerCase()

  // 用户规则优先匹配（可覆盖内置行为），内置规则兜底
  const allRules = [...userRules, ...BUILTIN_RULES]

  for (const rule of allRules) {
    if (rule.statusCodes.length > 0 && (statusCode === undefined || !rule.statusCodes.includes(statusCode))) {
      continue
    }
    if (rule.patterns.length > 0 && !rule.patterns.every((p) => matchPattern(p.toLowerCase(), lower))) {
      continue
    }
    return { category: rule.category ?? "unknown", rule }
  }

  return null
}
