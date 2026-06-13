/**
 * File magic bytes detection — identifies file types from binary signatures
 * (the first few bytes of a file) independent of Content-Type headers or
 * file extensions.
 *
 * This provides defense-in-depth against MIME-type spoofing attacks where an
 * attacker claims `image/png` but uploads executable content.
 */

// ── Magic byte signatures ─────────────────────────────────────────────────

interface MagicSignature {
  mime: string;
  /** Byte offsets to check: [offset, expected_bytes...] */
  bytes: number[];
  /** Offset into the buffer where these bytes appear */
  offset?: number;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  // ── Images ──
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF87a or GIF89a
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF....WEBP
  { mime: "image/bmp", bytes: [0x42, 0x4d] },
  { mime: "image/avif", bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], offset: 4 },

  // ── Audio ──
  { mime: "audio/mpeg", bytes: [0xff, 0xfb] }, // MP3 (also 0xFF 0xF3, 0xFF 0xF2)
  { mime: "audio/mpeg", bytes: [0x49, 0x44, 0x33] }, // MP3 with ID3 tag
  { mime: "audio/wav", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WAVE
  { mime: "audio/ogg", bytes: [0x4f, 0x67, 0x67, 0x53] },
  { mime: "audio/flac", bytes: [0x66, 0x4c, 0x61, 0x43] },
  { mime: "audio/aac", bytes: [0xff, 0xf1] }, // Also 0xFF 0xF9

  // ── Video ──
  { mime: "video/mp4", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ....ftyp
  { mime: "video/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: "video/quicktime", bytes: [0x66, 0x74, 0x79, 0x70, 0x71, 0x74], offset: 4 }, // ....ftypqt
  { mime: "video/x-msvideo", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....AVI
];

// ── Minimum bytes needed for detection ────────────────────────────────────

/** Read the first 256 bytes — enough for most container formats */
export const MAGIC_BYTES_READ_LENGTH = 256;

// ── Detection ─────────────────────────────────────────────────────────────

/**
 * Detect the MIME type of a file from its leading bytes (magic bytes).
 *
 * @param buffer The first N bytes of the file (at least 12, ideally 256)
 * @returns Detected MIME type, or `null` if unrecognized
 */
export function detectMimeFromMagicBytes(buffer: Uint8Array): string | null {
  if (buffer.length < 4) return null;

  for (const sig of MAGIC_SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (offset + sig.bytes.length > buffer.length) continue;

    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[offset + i] !== sig.bytes[i]!) {
        match = false;
        break;
      }
    }

    if (match) {
      // Special case: RIFF container — check sub-type
      if (sig.mime === "image/webp" && buffer.length >= 12) {
        const subType = String.fromCharCode(...Array.from(buffer.slice(8, 12)));
        if (subType === "WEBP") return "image/webp";
        if (subType === "AVI ") return "video/x-msvideo";
        if (subType === "WAVE") return "audio/wav";
        return null; // Unknown RIFF subtype
      }
      return sig.mime;
    }
  }

  return null;
}

/**
 * Check whether a claimed MIME type is consistent with the detected magic bytes.
 *
 * Comparison is based on the type category (image/video/audio) rather than
 * exact match, because subtypes can vary within the same format family
 * (e.g. `video/mp4` vs `video/quicktime` — both are valid MP4-family containers).
 *
 * @param claimedMime  The Content-Type claimed by uploader or S3 metadata
 * @param detectedMime The MIME type inferred from magic bytes (may be null)
 * @returns `true` if consistent or if magic detection is inconclusive (null)
 */
export function isMimeConsistentWithMagic(
  claimedMime: string,
  detectedMime: string | null,
): boolean {
  // If we couldn't detect anything, allow — server-side validation already passed
  if (!detectedMime) return true;

  // Extract top-level type (image, video, audio)
  const claimedCategory = claimedMime.split("/")[0];
  const detectedCategory = detectedMime.split("/")[0];

  // Categories must match
  if (claimedCategory !== detectedCategory) return false;

  // Within same category, allow subtype variations
  return true;
}
