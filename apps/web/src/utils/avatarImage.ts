/**
 * 0038 弟子自定义头像：浏览器端读图、裁剪、压缩（不依赖 Vue）。
 *
 * 玩家随便选一张图（手机照片几 MB 也行），这里裁成正方形、缩到 AVATAR_OUTPUT_SIZE，
 * 编码成 WebP（浏览器不支持导出 WebP 时用 JPEG），成品一般 5–15KB 再上传。
 * canvas 重新编码会顺带丢掉 EXIF（拍摄地点等），原图不会离开玩家的设备。
 *
 * 服务端（apps/server/src/modules/game/avatarImage.ts）会按文件头再校验格式 / 尺寸 / 大小，
 * 这里的上限与那边同口径：成品 ≤ 64KB、正方形、边长 32–512。
 */

/** 成品边长：头像最大显示 64px，按 2.5 倍屏留足清晰度。 */
export const AVATAR_OUTPUT_SIZE = 160;
/** 成品字节上限（与服务端 AVATAR_IMAGE_MAX_BYTES 同口径）。 */
export const AVATAR_MAX_BYTES = 64 * 1024;

export type AvatarMime = 'image/webp' | 'image/jpeg';

export interface CompressedAvatar {
  mime: AvatarMime;
  /** base64（不带 data: 前缀），直接作为请求体的 data 字段。 */
  data: string;
  /** 成品字节数（给界面显示「压缩后 xx KB」）。 */
  bytes: number;
}

/** 裁剪区域：源图像素坐标下的一个正方形。 */
export interface AvatarCrop {
  x: number;
  y: number;
  size: number;
}

export type AvatarSource = ImageBitmap | HTMLImageElement;

/** 头像图片地址（按内容哈希寻址，浏览器长缓存）。 */
export function avatarImageUrl(hash: string): string {
  return `/api/v1/game/avatars/${hash}`;
}

export function sourceSize(source: AvatarSource): { width: number; height: number } {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

/**
 * 读入玩家选的图片文件。优先 createImageBitmap（会按 EXIF 方向摆正手机照片），
 * 不支持时退回 <img> 解码；两者都失败（例如非 Safari 浏览器里的 HEIC）就报错让玩家换图。
 */
export async function loadAvatarSource(file: File): Promise<AvatarSource> {
  if (!file.type.startsWith('image/') && file.type !== '') {
    throw new Error('请选择图片文件');
  }
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // 继续尝试 <img> 解码。
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new Error('这张图片读不出来，换一张 JPG / PNG 试试');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 默认裁剪：取居中的最大正方形。 */
export function centeredCrop(width: number, height: number): AvatarCrop {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * 把裁剪区域画成 AVATAR_OUTPUT_SIZE 的正方形。
 * 缩小倍数很大时（几千像素的照片 → 160）分几次对半缩，避免一次缩到底产生锯齿和摩尔纹。
 */
function renderCrop(source: AvatarSource, crop: AvatarCrop): HTMLCanvasElement {
  let current: CanvasImageSource = source;
  let region = crop;
  let side = crop.size;
  while (side / 2 >= AVATAR_OUTPUT_SIZE * 1.5) {
    side = Math.round(side / 2);
    const step = makeCanvas(side);
    const context = step.getContext('2d');
    if (context === null) break;
    context.imageSmoothingQuality = 'high';
    context.drawImage(current, region.x, region.y, region.size, region.size, 0, 0, side, side);
    current = step;
    region = { x: 0, y: 0, size: side };
  }
  const output = makeCanvas(AVATAR_OUTPUT_SIZE);
  const context = output.getContext('2d');
  if (context === null) throw new Error('浏览器不支持图片处理');
  // 透明 PNG 转 JPEG 时透明处会变黑，先铺一层与头像底色一致的墨绿。
  context.fillStyle = '#0c211b';
  context.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    current,
    region.x,
    region.y,
    region.size,
    region.size,
    0,
    0,
    AVATAR_OUTPUT_SIZE,
    AVATAR_OUTPUT_SIZE,
  );
  return output;
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * 裁剪 + 压缩成上传用的成品。
 * 先试 WebP；Safari 等不支持导出 WebP 的浏览器会悄悄给出 PNG，此时改用 JPEG。
 * 万一超过上限就逐步降低质量（160×160 实际上几乎不会走到这一步）。
 */
export async function compressAvatar(source: AvatarSource, crop: AvatarCrop): Promise<CompressedAvatar> {
  const canvas = renderCrop(source, crop);
  const probe = await toBlob(canvas, 'image/webp', 0.82);
  const mime: AvatarMime = probe?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const blob = quality === 0.82 && mime === 'image/webp' ? probe : await toBlob(canvas, mime, quality);
    if (blob === null || blob.type !== mime) break;
    if (blob.size <= AVATAR_MAX_BYTES) {
      return { mime, data: await blobToBase64(blob), bytes: blob.size };
    }
  }
  throw new Error('图片压缩失败，换一张试试');
}
