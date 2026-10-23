-- Migration number: 0073 	 Name: sect_avatar_image
--
-- 宗门头像（玩家上传的图片，顶栏左侧的宗门 Logo；别人的宗门公开档案也显示它）：
--   sects <- 新增 avatar_hash 列（可空；NULL = 没有自定义头像，继续用静态的 /brand-logo.png）
--
-- 说明：
--   - 图片本体与弟子自定义头像共用 avatar_images 表（0038）：按内容哈希存，同一张图只存一份；
--     上传同样在浏览器里裁剪压缩成 160×160 的 WebP / JPEG，服务端按文件头再校验格式 / 尺寸 / 大小。
--   - 图片走 GET /api/v1/game/avatars/:hash，按内容寻址，响应带 immutable 长缓存。
--   - 孤儿清理（换图 / 移除 / 驱逐弟子）同时看 disciples.avatar_hash 与 sects.avatar_hash，
--     同一次 batch 里删掉不再被任何一方引用的旧图。
--   - 用 ADD COLUMN 加独立列，不需要重建表；不加外键，理由同上。

ALTER TABLE sects ADD COLUMN avatar_hash TEXT;

CREATE INDEX sects_avatar_hash_idx ON sects (avatar_hash);
