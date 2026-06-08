import { jsonError, jsonOk } from "@/lib/api-response";
import { getAvatarRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";
import { createAvatarProfile, createMockAvatarProvider } from "@/lib/services/avatar-provider";

export async function GET() {
  try {
    const avatars = await getAvatarRepository().listByOwner(demoOwnerId);
    return jsonOk({ avatars });
  } catch (error) {
    console.error("Failed to list avatars:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to list avatars", 500);
  }
}

export async function POST(request: Request) {
  const body = await request.json();

  try {
    const avatar = await createAvatarProfile({
      ownerId: body.ownerId ?? demoOwnerId,
      storeId: body.storeId,
      trainingVideoAssetId: body.trainingVideoAssetId,
      consentAccepted: Boolean(body.consentAccepted),
      provider: createMockAvatarProvider()
    });

    const saved = await getAvatarRepository().create(avatar);
    return jsonOk({ avatar: saved }, 201);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Avatar creation failed");
  }
}
