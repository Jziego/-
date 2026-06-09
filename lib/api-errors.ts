import type { NextResponse } from "next/server";
import { jsonError } from "@/lib/api-response";

export const INVALID_JSON_BODY_MESSAGE = "Invalid JSON body";

function isInvalidJsonBody(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }

  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    return message.includes("json") || message.includes("body");
  }

  return false;
}

export function handleRouteError(context: string, error: unknown): NextResponse<{ error: string }> {
  if (isInvalidJsonBody(error)) {
    return jsonError(INVALID_JSON_BODY_MESSAGE, 400);
  }

  console.error(`${context}:`, error);
  return jsonError(context, 500);
}
