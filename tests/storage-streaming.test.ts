import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn()
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = sendMock;
    constructor() {}
  }

  class GetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  return { S3Client, GetObjectCommand, PutObjectCommand };
});

describe("storage streaming helpers（资源治理 Task B）", () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OBJECT_STORAGE_ENDPOINT = "http://127.0.0.1:9000";
    process.env.OBJECT_STORAGE_BUCKET = "ai-video-assistant";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "minioadmin";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "minioadmin";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    dir = mkdtempSync(join(tmpdir(), "storage-stream-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("getObjectToFile 把多 chunk 流按序写入目标文件（字节级完整）", async () => {
    const dest = join(dir, "out.bin");
    // 三个 chunk、含 0x00 与跨 chunk 边界，验证顺序与完整：
    const chunks = [
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from([0x04, 0x05]),
      Buffer.from([0x06, 0x07, 0x08, 0xff])
    ];
    sendMock.mockResolvedValue({ Body: Readable.from(chunks) });

    const { resetS3ClientForTests } = await import("@/lib/storage");
    const { getObjectToFile } = await import("@/lib/storage-stream");
    resetS3ClientForTests();

    await getObjectToFile("media/footage.mp4", dest);

    expect(readFileSync(dest)).toEqual(Buffer.concat(chunks));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      input: { Bucket: "ai-video-assistant", Key: "media/footage.mp4" }
    });
  });

  it("getObjectToFile 在 Body 为 undefined 时写出空文件（与 getObjectToBuffer 语义对齐）", async () => {
    const dest = join(dir, "empty.bin");
    sendMock.mockResolvedValue({});

    const { resetS3ClientForTests } = await import("@/lib/storage");
    const { getObjectToFile } = await import("@/lib/storage-stream");
    resetS3ClientForTests();

    await getObjectToFile("media/empty.mp4", dest);

    expect(readFileSync(dest)).toEqual(Buffer.from([]));
  });

  it("putObjectFromStream 以流为 Body，读出后与源文件逐字节一致", async () => {
    const src = join(dir, "src.bin");
    // 256 字节确定性负载：覆盖 fs read stream 的分块边界
    const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 251));
    await writeFile(src, payload);
    sendMock.mockResolvedValue({});

    const { resetS3ClientForTests } = await import("@/lib/storage");
    const { putObjectFromStream } = await import("@/lib/storage-stream");
    resetS3ClientForTests();

    await putObjectFromStream("renders/proj_1/output.mp4", src, "video/mp4");

    const command = sendMock.mock.calls[0]?.[0] as {
      input: { Bucket: string; Key: string; ContentType: string; Body: Readable };
    };
    expect(command).toMatchObject({
      input: {
        Bucket: "ai-video-assistant",
        Key: "renders/proj_1/output.mp4",
        ContentType: "video/mp4"
      }
    });
    // 关键：Body 必须是流（渲染路径内存治理的成败点），而不是整文件字节
    expect(command.input.Body).toBeInstanceOf(Readable);

    let received = Buffer.alloc(0);
    await pipeline(command.input.Body, async function* (source) {
      for await (const chunk of source) {
        received = Buffer.concat([received, chunk as Buffer]);
      }
    });
    expect(received).toEqual(payload);
  });
});
