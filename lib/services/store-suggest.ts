import { chatCompletionJSON, sanitizePromptField } from "@/lib/services/ai-client";

export interface StoreSuggestionInput {
  name: string;
  industry: string;
  location?: string;
}

export interface StoreSuggestion {
  mainProducts: string[];
  sellingPoints: string[];
  targetCustomers: string[];
  promotions: string[];
  brandTone: string;
}

/**
 * Thrown when AI suggestion cannot be produced (no key, empty response). The
 * route maps this to a 502 so the user can retry or fall back to manual entry.
 */
export class StoreSuggestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreSuggestionError";
  }
}

const SUGGEST_SYSTEM_PROMPT = `你是本地商家短视频的门店档案顾问。根据店名、行业、位置，为商家生成营销短视频所需的门店档案内容建议。

规则：
- mainProducts: 2-5个主营产品/服务（中文，贴合这个行业与店名）
- sellingPoints: 2-4个卖点（如现做、性价比、出餐快、环境好、手作等）
- targetCustomers: 2-4个目标客群（如附近上班族、社区居民、学生、家庭等）
- promotions: 0-3个适合的促销活动（如工作日套餐、第二份半价、到店赠品），可为空数组
- brandTone: 一个简短的说话风格（如"亲切接地气"、"专业有质感"、"活泼俏皮"）

仅依据店名/行业/位置做合理推断，不要编造具体到不真实的细节。`;

const SUGGEST_SCHEMA = `{
  "mainProducts": ["产品1", "产品2"],
  "sellingPoints": ["卖点1", "卖点2"],
  "targetCustomers": ["客群1", "客群2"],
  "promotions": ["活动1"],
  "brandTone": "说话风格"
}`;

interface RawSuggestion {
  mainProducts?: unknown;
  sellingPoints?: unknown;
  targetCustomers?: unknown;
  promotions?: unknown;
  brandTone?: unknown;
}

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => String(v).trim()).filter(Boolean))).slice(0, max);
}

function normalizeSuggestion(raw: RawSuggestion): StoreSuggestion {
  const brandTone =
    typeof raw.brandTone === "string" && raw.brandTone.trim()
      ? raw.brandTone.trim().slice(0, 40)
      : "亲切接地气";
  return {
    mainProducts: toStringArray(raw.mainProducts, 6),
    sellingPoints: toStringArray(raw.sellingPoints, 6),
    targetCustomers: toStringArray(raw.targetCustomers, 6),
    promotions: toStringArray(raw.promotions, 5),
    brandTone
  };
}

export async function suggestStoreProfile(input: StoreSuggestionInput): Promise<StoreSuggestion> {
  const userPrompt = [
    `店名：${sanitizePromptField(input.name, 100)}`,
    `行业：${sanitizePromptField(input.industry, 50)}`,
    input.location ? `位置：${sanitizePromptField(input.location, 100)}` : null
  ].filter(Boolean).join("\n");

  const result = await chatCompletionJSON<RawSuggestion>(SUGGEST_SYSTEM_PROMPT, userPrompt, {
    schemaDescription: SUGGEST_SCHEMA,
    temperature: 0.6,
    maxTokens: 800
  });

  if (!result) {
    throw new StoreSuggestionError("AI returned empty suggestion");
  }
  return normalizeSuggestion(result);
}

// ── 候选池模式（批次二）：按字段出 8 条候选，exclude 去重 ─────────────────────

export interface FieldCandidateInput extends StoreSuggestionInput {
  field: "mainProducts" | "sellingPoints";
  exclude?: string[];
  nickname?: string;
  ownerAge?: number;
  yearsInBusiness?: number;
}

export interface FieldCandidateDeps {
  /** 测试注入；缺省走真 AI。 */
  chatJsonFn?: (
    systemPrompt: string,
    userPrompt: string,
    options: { schemaDescription: string; temperature: number; maxTokens: number },
  ) => Promise<{ candidates?: unknown } | null>;
}

const FIELD_CANDIDATE_PROMPTS: Record<FieldCandidateInput["field"], string> = {
  mainProducts: `你是本地商家短视频的门店档案顾问。根据门店基础信息，给出 8 条该店可能的【主营业务】候选条目。
规则：
- 每条 4-12 字口语短语（如「短视频代运营」「工作日午市套餐」），贴合行业与店名
- 按最可能到次可能排序，彼此角度不同，不重复用户已有条目
- 仅依据门店信息合理推断，不编造具体到不真实的细节`,
  sellingPoints: `你是本地商家短视频的门店档案顾问。根据门店基础信息，给出 8 条该店可能的【门店特色/优势】候选条目。
规则：
- 每条 4-14 字口语短语（如「15年行业深耕经验」「一对一诊断门店现状」），贴合行业与人设
- 覆盖不同维度（经验/服务/效果/价格/效率），不重复用户已有条目
- 仅依据门店信息合理推断，不编造具体到不真实的细节`,
};

const FIELD_CANDIDATE_SCHEMA = `{ "candidates": ["候选1", "候选2", "候选3", "候选4", "候选5", "候选6", "候选7", "候选8"] }`;

export async function suggestFieldCandidates(
  input: FieldCandidateInput,
  deps?: FieldCandidateDeps,
): Promise<string[]> {
  const chatJson: NonNullable<FieldCandidateDeps["chatJsonFn"]> =
    deps?.chatJsonFn ??
    ((systemPrompt, userPrompt, options) =>
      chatCompletionJSON<{ candidates?: unknown }>(systemPrompt, userPrompt, options));
  const excludeList = (input.exclude ?? [])
    .map((e) => sanitizePromptField(e, 30))
    .filter(Boolean);

  const userPrompt = [
    `店名：${sanitizePromptField(input.name, 100)}`,
    `行业：${sanitizePromptField(input.industry, 50)}`,
    input.location ? `位置：${sanitizePromptField(input.location, 100)}` : null,
    input.nickname ? `店主称呼：${sanitizePromptField(input.nickname, 20)}` : null,
    input.ownerAge ? `店主年龄：${input.ownerAge}` : null,
    input.yearsInBusiness ? `店龄：${input.yearsInBusiness}年` : null,
    excludeList.length ? `已存在条目（不要重复）：${excludeList.join("、")}` : null,
  ].filter(Boolean).join("\n");

  const result = await chatJson(FIELD_CANDIDATE_PROMPTS[input.field], userPrompt, {
    schemaDescription: FIELD_CANDIDATE_SCHEMA,
    temperature: 0.7,
    maxTokens: 800,
  });
  if (!result) {
    throw new StoreSuggestionError("AI returned empty candidates");
  }
  return toStringArray(result.candidates, 8);
}
