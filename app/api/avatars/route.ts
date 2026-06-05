import { jsonError, jsonOk } from "@/lib/api-response";
import { getRuntimeState } from "@/lib/runtime-store";
import { createAvatarProfile, createMockAvatarProvider } from "@/lib/services/avatar-provider";

export async function GET() {
  return jsonOk({ avatars: getRuntimeState().avatars });
}

export async function POST(request: Request) {
  const body = await request.json();

  try {
    const avatar = await createAvatarProfile({
      ownerId: body.ownerId ?? "demo_user",
      storeId: body.storeId,
      trainingVideoAssetId: body.trainingVideoAssetId,
      consentAccepted: Boolean(body.consentAccepted),
      provider: createMockAvatarProvider()
    });

    getRuntimeState().avatars.push(avatar);
    return jsonOk({ avatar }, 201);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Avatar creation failed");
  }
}
