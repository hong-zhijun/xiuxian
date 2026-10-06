import { AppError } from '../../http/appError';

/**
 * 0038 弟子自定义头像：服务端对「浏览器压缩后的成品」再校验一次（纯函数，不碰数据库）。
 *
 * 压缩在前端完成（apps/web/src/utils/avatarImage.ts：裁正方形 → 160×160 → WebP，浏览器不支持时 JPEG），
 * 这里不信任前端，只认：
 *   - 格式：按文件头识别 WebP（RIFF....WEBP）或 JPEG（FF D8 FF），声明的 mime 必须与文件头一致；
 *   - 大小：解码后 ≤ AVATAR_IMAGE_MAX_BYTES；
 *   - 尺寸：从文件头读出宽高，必须是正方形且边长在 [MIN, MAX] 之间
 *     （防止十几 KB 的纯色大图在别人浏览器里解码成几百 MB 的位图）。
 * 不在服务端解码 / 重新编码图片（Worker 里没有图像库），也不需要：浏览器渲染 <img> 本身是沙箱。
 */

export const AVATAR_IMAGE_MIMES = ['image/webp', 'image/jpeg'] as const;
export type AvatarImageMime = (typeof AVATAR_IMAGE_MIMES)[number];

/** 成品字节上限（与 0038 迁移里 data 列的 CHECK 同口径：64KB 原始字节）。 */
export const AVATAR_IMAGE_MAX_BYTES = 64 * 1024;
/** base64 文本上限（4 字符 / 3 字节，向上取整到 4 的倍数）：schema 先挡掉超长请求体。 */
export const AVATAR_IMAGE_MAX_BASE64_CHARS = Math.ceil(AVATAR_IMAGE_MAX_BYTES / 3) * 4;
export const AVATAR_IMAGE_MIN_SIDE = 32;
export const AVATAR_IMAGE_MAX_SIDE = 512;

/** 内容哈希：64 位小写十六进制 SHA-256（也是图片地址的一部分）。 */
export const AVATAR_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface ValidatedAvatarImage {
  hash: string;
  mime: AvatarImageMime;
  /** 规范化后的 base64（重新编码一次，去掉空白等非规范写法）。 */
  base64: string;
  bytes: Uint8Array;
}

function invalid(reason: string): AppError {
  return new AppError('VALIDATION_ERROR', '头像图片无效，请换一张图片重试', { reason });
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function sniffMime(bytes: Uint8Array): AvatarImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** WebP 宽高：VP8（有损）/ VP8L（无损）/ VP8X（扩展）三种块头。 */
function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8 ') {
    // 帧头起始码 9D 01 2A 之后是 14 位宽、14 位高（小端）。
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  return null;
}

/** JPEG 宽高：顺着段头找第一个 SOFn（C0–CF，排除 C4 / C8 / CC）。 */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 没有长度字段的独立标记（RSTn / TEM）。
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 校验上传的头像成品；任何一项不合格都是 VALIDATION_ERROR（不回显原始数据）。 */
export async function validateAvatarImage(mime: string, base64: string): Promise<ValidatedAvatarImage> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch {
    throw invalid('BASE64');
  }
  if (bytes.length === 0 || bytes.length > AVATAR_IMAGE_MAX_BYTES) {
    throw invalid('SIZE');
  }
  const sniffed = sniffMime(bytes);
  if (sniffed === null || sniffed !== mime) {
    throw invalid('FORMAT');
  }
  const size = sniffed === 'image/webp' ? webpSize(bytes) : jpegSize(bytes);
  if (
    size === null ||
    size.width !== size.height ||
    size.width < AVATAR_IMAGE_MIN_SIDE ||
    size.width > AVATAR_IMAGE_MAX_SIDE
  ) {
    throw invalid('DIMENSIONS');
  }
  return { hash: await sha256Hex(bytes), mime: sniffed, base64: bytesToBase64(bytes), bytes };
}
