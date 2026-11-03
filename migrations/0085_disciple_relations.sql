-- Migration number: 0085   Name: disciple_relations
-- 师徒与弟子羁绊统一关系行。bond 行中的 mentor_id/disciple_id 是稳定排序后的 pair 两端，
-- 不代表师徒语义；公开名称/境界始终从 disciples 当前行 JOIN 得到。
CREATE TABLE disciple_relations (
  id TEXT NOT NULL PRIMARY KEY,
  sect_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('mentorship','bond')),
  status TEXT NOT NULL CHECK(status IN ('active','graduated','cancelled')),
  mentor_id TEXT NOT NULL,
  disciple_id TEXT NOT NULL,
  bond_kind TEXT CHECK(bond_kind IS NULL OR bond_kind IN ('fellow','partner','rival')),
  target_realm_index INTEGER CHECK(target_realm_index IS NULL OR target_realm_index >= 0),
  teaching_value INTEGER NOT NULL DEFAULT 0 CHECK(teaching_value >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  mentor_bonus TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(mentor_bonus)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  graduated_at INTEGER,
  cancelled_at INTEGER,
  FOREIGN KEY(mentor_id) REFERENCES disciples(id),
  FOREIGN KEY(disciple_id) REFERENCES disciples(id),
  CHECK(mentor_id <> disciple_id),
  CHECK((kind='mentorship' AND bond_kind IS NULL AND target_realm_index IS NOT NULL)
    OR (kind='bond' AND bond_kind IS NOT NULL AND target_realm_index IS NULL)),
  CHECK((status='graduated' AND graduated_at IS NOT NULL)
    OR (status<>'graduated' AND graduated_at IS NULL)),
  CHECK((status='cancelled' AND cancelled_at IS NOT NULL)
    OR (status<>'cancelled' AND cancelled_at IS NULL))
);
CREATE INDEX disciple_relations_sect_status ON disciple_relations(sect_id,kind,status,updated_at,id);
CREATE INDEX disciple_relations_mentor_active ON disciple_relations(sect_id,mentor_id,kind,status);
CREATE INDEX disciple_relations_disciple_active ON disciple_relations(sect_id,disciple_id,kind,status);
-- 每个弟子至多一个 active 师徒关系；其它历史关系保留。
CREATE UNIQUE INDEX disciple_relations_active_mentorship_disciple
  ON disciple_relations(sect_id,disciple_id) WHERE kind='mentorship' AND status='active';
-- bond 端点固定按字典序落在两列，避免同一 pair 多行；service 额外守卫每个端点只绑定一对。
CREATE UNIQUE INDEX disciple_relations_active_bond_pair
  ON disciple_relations(sect_id,mentor_id,disciple_id) WHERE kind='bond' AND status='active';
CREATE TABLE relation_commands (
  sect_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(sect_id,command_id)
);
-- 积累真实修为变动，结算/丹药/历练等现有 UPDATE 均自动计入。
CREATE TRIGGER disciple_relations_teaching_cultivation
AFTER UPDATE OF cultivation ON disciples
WHEN NEW.cultivation > OLD.cultivation
BEGIN
  UPDATE disciple_relations
     SET teaching_value = teaching_value + (NEW.cultivation - OLD.cultivation),
         updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
   WHERE disciple_id = NEW.id AND kind='mentorship' AND status='active';
END;
