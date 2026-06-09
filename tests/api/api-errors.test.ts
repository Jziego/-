import { describe, expect, it } from "vitest";
import { handleRouteError, INVALID_JSON_BODY_MESSAGE } from "@/lib/api-errors";

describe("handleRouteError", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = handleRouteError("Failed to create asset", new SyntaxError("Unexpected token"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(INVALID_JSON_BODY_MESSAGE);
  });

  it("returns 500 with a fixed message for unexpected errors", async () => {
    const response = handleRouteError("Failed to list assets", new Error("secret database error"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to list assets");
    expect(body.error).not.toContain("secret database error");
  });
});
