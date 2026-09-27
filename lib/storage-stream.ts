import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { getObjectStorageBucket, getS3Client } from "@/lib/storage";

/**
 * 流式存储原语（worker 渲染路径专用，服务端 only）。
 *
 * 从 lib/storage.ts 拆出：storage.ts 会被客户端组件经 lib/services/assets.ts
 * 打包进 web bundle（webpack 无法为浏览器图解析 node:fs/node:stream），而本模块
 * 的流式实现必须直接用 Node 内置模块——故独立成 server-only 模块。
 */

/**
 * Stream an object from storage directly to a local file (worker render path).
 * Peak memory = stream buffers (KB), not file size — replaces the
 * getObjectToBuffer+writeFile double-buffer (was 2× file size in heap).
 */
export async function getObjectToFile(key: string, destPath: string): Promise<void> {
  const response = await getS3Client().send(
    new GetObjectCommand({ Bucket: getObjectStorageBucket(), Key: key })
  );
  if (!response.Body) {
    await writeFile(destPath, new Uint8Array(0));
    return;
  }
  await pipeline(response.Body as Readable, createWriteStream(destPath));
}

/**
 * Upload a local file to storage as a stream (worker render output path).
 * Replaces readFile + Uint8Array-copy + putObjectFromBuffer (was 2-3× file size).
 */
export async function putObjectFromStream(key: string, filePath: string, contentType: string): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getObjectStorageBucket(),
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType
    })
  );
}
