-- Migration number: 0038 	 Name: disciple_avatar_image
--
-- 弟子自定义头像（玩家上传的图片，铺满整个圆形头像）：
--   avatar_images  <- 新表：按内容哈希存图片本体（base64 文本），同一张图只存一份
--   disciples      <- 新增 avatar_hash 列（可空；NULL = 没有自定义头像，沿用头像框 / 旧式）
--
-- 说明：
--   - 压缩在浏览器里完成（裁正方形 → 缩到 160×160 → WebP / JPEG），服务端只收成品，
--     并再校验一次格式、尺寸与大小（见 apps/server/src/modules/game/avatarImage.ts），单张一般 5–15KB。
--   - 图片走 GET /api/v1/game/avatars/:hash，按内容寻址，响应带 immutable 长缓存；
--     宗门状态 / 排行榜等接口只带 hash，不内联图片本体。
--   - 自定义头像是公开外观：自己的名册、天骄榜、弟子公开档案、宗门公开档案都会显示。
--   - 用 ADD COLUMN 加独立列，而不是往 avatar_frame_id 的 CHECK 里加值（改 CHECK 要像 0018 那样重建整张表）。
--   - 不加外键：换头像 / 移除头像 / 驱逐弟子时，在同一个 batch 里删掉不再被任何弟子引用的图片。

CREATE TABLE avatar_images (
  hash TEXT PRIMARY KEY
    CHECK (length(hash) = 64),
  mime TEXT NOT NULL
    CHECK (mime IN ('image/webp', 'image/jpeg')),
  -- base64 文本而不是 BLOB：D1 读 BLOB 返回数字数组、node:sqlite 返回 Uint8Array，两边口径不一；
  -- 图片本身只有十几 KB，base64 多出的 1/3 无关紧要。上限 87384 字符 = 64KB 原始字节。
  data TEXT NOT NULL
    CHECK (length(data) <= 87384),
  created_at INTEGER NOT NULL
);

ALTER TABLE disciples ADD COLUMN avatar_hash TEXT;

CREATE INDEX disciples_avatar_hash_idx ON disciples (avatar_hash);
