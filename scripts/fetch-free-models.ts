/**
 * OpenCode Zen 免费模型拉取脚本
 *
 * 数据源: models.dev/api.json (公开 API，无需 API Key)
 * Provider: opencode (OpenCode Zen)
 *
 * 用法:
 *   npx tsx scripts/fetch-free-models.ts
 *   # 或
 *   bun run scripts/fetch-free-models.ts
 */

const MODELS_DEV_API = "https://models.dev/api.json";
const OPENCODE_PROVIDER = "opencode";

interface ModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
}

interface ModelLimit {
  context: number;
  output: number;
}

interface ModelInfo {
  id: string;
  name: string;
  family: string;
  attachment: boolean;
  reasoning: boolean;
  tool_call: boolean;
  temperature: boolean;
  modalities: {
    input: string[];
    output: string[];
  };
  open_weights: boolean;
  cost: ModelCost;
  limit: ModelLimit;
  release_date?: string;
  last_updated?: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  api: string;
  doc: string;
  env: string[];
  models: Record<string, ModelInfo>;
}

function isFree(cost: ModelCost): boolean {
  return cost.input === 0 && cost.output === 0;
}

function formatCost(cost: ModelCost): string {
  if (isFree(cost)) return "FREE";
  const parts: string[] = [];
  parts.push(`in=${cost.input}`);
  parts.push(`out=${cost.output}`);
  if (cost.cache_read) parts.push(`cache_r=${cost.cache_read}`);
  if (cost.cache_write) parts.push(`cache_w=${cost.cache_write}`);
  return `$${parts.join("/")}`;
}

function formatContextLimit(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}M`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)}K`;
  return `${bytes}`;
}

async function main() {
  console.log("Fetching models from models.dev...\n");

  const resp = await fetch(MODELS_DEV_API);
  if (!resp.ok) {
    console.error(`Failed to fetch models.dev API: ${resp.status} ${resp.statusText}`);
    process.exit(1);
  }

  const data = await resp.json() as Record<string, ProviderInfo>;
  const provider = data[OPENCODE_PROVIDER];

  if (!provider) {
    console.error(`Provider "${OPENCODE_PROVIDER}" not found in models.dev API`);
    process.exit(1);
  }

  const allModels = Object.values(provider.models);
  const freeModels = allModels.filter((m) => isFree(m.cost));
  const paidModels = allModels.filter((m) => !isFree(m.cost));

  // ─── 输出 1: 免费模型 ID 列表（每行一个，带 opencode/ 前缀） ───
  console.log("=== Free Model IDs ===\n");
  for (const m of freeModels.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`opencode/${m.id}`);
  }

  // ─── 输出 2: 免费模型详细表格 ───
  console.log(`\n=== Free Models Detail (${freeModels.length} models) ===\n`);

  // 表头
  const headerCols = [
    pad("Model ID", 35),
    pad("Name", 30),
    pad("Reasoning", 10),
    pad("ToolCall", 10),
    pad("Context", 10),
    pad("Output", 10),
    pad("Family", 15),
    "Updated",
  ];
  console.log(headerCols.join(" | "));
  console.log("-".repeat(headerCols.join(" | ").length));

  for (const m of freeModels.sort((a, b) => a.id.localeCompare(b.id))) {
    const cols = [
      pad(m.id, 35),
      pad(m.name, 30),
      pad(m.reasoning ? "✓" : "✗", 10),
      pad(m.tool_call ? "✓" : "✗", 10),
      pad(formatContextLimit(m.limit.context), 10),
      pad(formatContextLimit(m.limit.output), 10),
      pad(m.family, 15),
      m.last_updated || "N/A",
    ];
    console.log(cols.join(" | "));
  }

  // ─── 输出 3: 所有模型汇总（含付费） ───
  console.log(`\n=== All Models Summary (${allModels.length} total) ===\n`);

  const allHeaderCols = [
    pad("Model ID", 35),
    pad("Name", 30),
    pad("Free", 5),
    pad("Cost", 25),
    pad("Reasoning", 10),
    pad("ToolCall", 10),
    pad("Context", 10),
    "Family",
  ];
  console.log(allHeaderCols.join(" | "));
  console.log("-".repeat(allHeaderCols.join(" | ").length));

  for (const m of allModels.sort((a, b) => {
    // 免费排前面
    const fa = isFree(a.cost) ? 0 : 1;
    const fb = isFree(b.cost) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.id.localeCompare(b.id);
  })) {
    const cols = [
      pad(m.id, 35),
      pad(m.name, 30),
      pad(isFree(m.cost) ? "✓" : "✗", 5),
      pad(formatCost(m.cost), 25),
      pad(m.reasoning ? "✓" : "✗", 10),
      pad(m.tool_call ? "✓" : "✗", 10),
      pad(formatContextLimit(m.limit.context), 10),
      m.family,
    ];
    console.log(cols.join(" | "));
  }

  // ─── 输出 4: JSON 格式（方便程序调用） ───
  const jsonOutput = freeModels
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      providerModelId: `opencode/${m.id}`,
      name: m.name,
      family: m.family,
      reasoning: m.reasoning,
      toolCall: m.tool_call,
      contextLimit: m.limit.context,
      outputLimit: m.limit.output,
      openWeights: m.open_weights,
      lastUpdated: m.last_updated || null,
    }));

  console.log(`\n=== JSON Output (free models only) ===\n`);
  console.log(JSON.stringify(jsonOutput, null, 2));

  // ─── Provider 信息 ───
  console.log(`\n=== Provider Info ===\n`);
  console.log(`  Name:    ${provider.name}`);
  console.log(`  API:     ${provider.api}`);
  console.log(`  Docs:    ${provider.doc}`);
  console.log(`  Env:     ${provider.env.join(", ")}`);
  console.log(`  Total:   ${allModels.length} models (${freeModels.length} free, ${paidModels.length} paid)`);
}

function pad(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + " ".repeat(len - str.length);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
