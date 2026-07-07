import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for seeding");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  await prisma.user.upsert({
    where: { id: "demo_user" },
    update: {},
    create: {
      id: "demo_user",
      email: "demo@example.com",
      plan: "free",
      quotaRemaining: 10
    }
  });

  // System BGM library (Q3: tracks live in R2 at bgm/<id>.mp3; rows are metadata).
  // The mp3 files themselves are an ops upload step — see prisma/bgm-seed-assets/README.md.
  const bgmTracks = [
    { id: "bgm_upbeat_01", name: "明快节奏 01", storageKey: "bgm/bgm_upbeat_01.mp3", durationSeconds: 30, category: "upbeat" },
    { id: "bgm_calm_01", name: "舒缓 01", storageKey: "bgm/bgm_calm_01.mp3", durationSeconds: 30, category: "calm" },
    { id: "bgm_corporate_01", name: "商务 01", storageKey: "bgm/bgm_corporate_01.mp3", durationSeconds: 30, category: "corporate" }
  ];
  for (const track of bgmTracks) {
    await prisma.bgmTrack.upsert({
      where: { id: track.id },
      update: {},
      create: track
    });
  }
  console.log(`Seeded ${bgmTracks.length} BGM tracks`);
}

main().finally(async () => {
  await prisma.$disconnect();
  await pool.end();
});
