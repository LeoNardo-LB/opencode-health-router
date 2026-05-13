import type { ClassificationRule } from "../types.js"

export const BUILTIN_RULES: ClassificationRule[] = [
  // 状态码 → category
  { statusCodes: [429], patterns: [], category: "rate_limit" },
  { statusCodes: [402], patterns: [], category: "quota_exceeded" },
  { statusCodes: [500, 502, 503, 504], patterns: [], category: "5xx" },
  { statusCodes: [529], patterns: [], category: "overloaded" },
  // Pattern → category（% 通配符）
  // ─── rate_limit ───
  { statusCodes: [], patterns: ["%已达到%使用上限%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%已达上限%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%访问量过大%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%稍后再试%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%请求过于频繁%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%请求次数%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%rate limit%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%too many requests%"], category: "rate_limit" },
  { statusCodes: [], patterns: ["%frequency%"], category: "rate_limit" },
  // ─── overloaded ───
  { statusCodes: [], patterns: ["%overloaded%"], category: "overloaded" },
  { statusCodes: [], patterns: ["%capacity%"], category: "overloaded" },
  { statusCodes: [], patterns: ["%busy%"], category: "overloaded" },
  // ─── quota_exceeded ───
  { statusCodes: [], patterns: ["%已用尽%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%call quota%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%insufficient_quota%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%quota exceeded%"], category: "quota_exceeded" },
  { statusCodes: [], patterns: ["%配额%"], category: "quota_exceeded" },
  // ─── timeout ───
  { statusCodes: [], patterns: ["%timeout%"], category: "timeout" },
  { statusCodes: [], patterns: ["%timed out%"], category: "timeout" },
]
