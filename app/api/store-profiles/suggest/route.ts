import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { hasAI } from "@/lib/services/ai-client";
import { suggestStoreProfile, StoreSuggestionError } from "@/lib/services/store-suggest";
import { storeSuggestionInputSchema } from "@/lib/schemas";

/**
 * AI-suggest hard-to-fill store-profile fields (mainProducts/sellingPoints/
 * targetCustomers/promotions/brandTone) from name+industry+location. Output is
 * shown for review — it is NOT persisted here (the client fills the form, the
 * user saves via the existing upsert). AI failure → 502 so the user can retry.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const parsed = storeSuggestionInputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  if (!hasAI()) {
    return jsonError("未配置 AI，无法生成建议", 503);
  }

  try {
    const suggestion = await suggestStoreProfile(parsed.data);
    return jsonOk({ suggestion });
  } catch (error) {
    if (error instanceof StoreSuggestionError) {
      return jsonError("AI 建议生成失败，请重试或手动填写", 502);
    }
    return jsonError("AI 建议生成失败，请重试或手动填写", 502);
  }
}
