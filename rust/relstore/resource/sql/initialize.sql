-- relstore 关系记忆库初始化脚本（schema v5 对齐 docs/2026-09-16-sqlite-migration-analysis.md）
-- 仅在库文件不存在时由 initialize.rs 执行；已有库由 initialize.rs 增量迁移。
-- 家法对齐 dbvault：外键关闭（initialize.sql 显式声明），完整性由 service 层 +
-- Helper::executes 单连接事务保证（contact 级联删除、plan sent 两步写入）。

PRAGMA foreign_keys = false;

DROP TABLE IF EXISTS "memories";
DROP TABLE IF EXISTS "materials";
DROP TABLE IF EXISTS "plans";
DROP TABLE IF EXISTS "contacts";
DROP TABLE IF EXISTS "relation_types";

-- 关系类型注册表：key 为联系人 relation 字段的存储值，label 为显示名。
-- 自定义类型由工作台增删改；内置 6 类（builtin=1）不可删除。
CREATE TABLE "relation_types" (
  "key" TEXT(32) NOT NULL,
  "label" TEXT(64) NOT NULL,
  "sort" INTEGER NOT NULL DEFAULT 100,
  "builtin" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT(64),
  "updated_at" TEXT(64),
  PRIMARY KEY ("key"),
  CHECK ("builtin" IN (0,1))
);

-- 播种内置类型（与历史写死列表一致；created_at 留空表示出厂内置）
INSERT INTO "relation_types" ("key", "label", "sort", "builtin") VALUES
  ('family', '家人', 1, 1),
  ('friend', '朋友', 2, 1),
  ('colleague', '同事', 3, 1),
  ('client', '客户', 4, 1),
  ('partner', '伙伴', 5, 1),
  ('other', '其他', 6, 1);

CREATE TABLE "contacts" (
  "id" TEXT(40) NOT NULL,
  "name" TEXT(80) NOT NULL,
  "relation" TEXT(32) NOT NULL DEFAULT 'other',
  "tags" TEXT(512) DEFAULT '[]',
  "birthday" TEXT(16) DEFAULT '',
  "notes" TEXT(2048) DEFAULT '',
  "archived" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT(12) NOT NULL DEFAULT 'confirmed',
  "created_at" TEXT(64),
  "updated_at" TEXT(64),
  PRIMARY KEY ("id"),
  CHECK ("archived" IN (0,1)),
  CHECK ("status" IN ('pending','confirmed'))
);

CREATE TABLE "materials" (
  "id" TEXT(40) NOT NULL,
  "kind" TEXT(16) NOT NULL DEFAULT 'text',
  "text" TEXT NOT NULL,
  "excerpt" TEXT(256) DEFAULT '',
  "contact_id" TEXT(40) DEFAULT '',
  "occasion" TEXT(48) DEFAULT '',
  "captured_at" TEXT(64),
  PRIMARY KEY ("id"),
  CHECK ("kind" IN ('text','screenshot','file'))
);

CREATE TABLE "memories" (
  "id" TEXT(40) NOT NULL,
  "contact_id" TEXT(40) NOT NULL,
  "mem_type" TEXT(16) NOT NULL,
  "content" TEXT NOT NULL,
  "date" TEXT(16) DEFAULT '',
  "said_at" TEXT(24) DEFAULT '',
  "importance" INTEGER NOT NULL DEFAULT 2,
  "direction" TEXT(16) NOT NULL DEFAULT '',
  "lifespan" TEXT(8) NOT NULL DEFAULT 'long',
  "occasion" TEXT(48) DEFAULT '',
  "source_id" TEXT(40) DEFAULT '',
  "source_quote" TEXT(200) DEFAULT '',
  "author" TEXT(8) NOT NULL DEFAULT 'ai',
  "status" TEXT(12) NOT NULL DEFAULT 'pending',
  "reason" TEXT(512) DEFAULT '',
  "superseded_by" TEXT(40) DEFAULT '',
  "confirmed_at" TEXT(64),
  "created_at" TEXT(64),
  "updated_at" TEXT(64),
  PRIMARY KEY ("id"),
  CHECK ("mem_type" IN ('preference','dislike','taboo','event','gift','promise','interaction','attribute')),
  CHECK ("direction" IN ('','user_to_contact','contact_to_user','both')),
  CHECK ("lifespan" IN ('long','short')),
  CHECK ("author" IN ('user','ai')),
  CHECK ("status" IN ('pending','confirmed','rejected')),
  CHECK ("importance" BETWEEN 1 AND 3)
);

CREATE TABLE "plans" (
  "id" TEXT(40) NOT NULL,
  "contact_id" TEXT(40) NOT NULL,
  "occasion" TEXT(48) DEFAULT '',
  "occasion_date" TEXT(16) DEFAULT '',
  "idea" TEXT(256) NOT NULL,
  "budget" TEXT(48) DEFAULT '',
  "product_name" TEXT(128) DEFAULT '',
  "product_price" TEXT(48) DEFAULT '',
  "product_url" TEXT(512) DEFAULT '',
  "status" TEXT(12) NOT NULL DEFAULT 'idea',
  "sent_at" TEXT(64) DEFAULT '',
  "memory_id" TEXT(40) DEFAULT '',
  "source" TEXT(8) NOT NULL DEFAULT 'user',
  "created_at" TEXT(64),
  "updated_at" TEXT(64),
  PRIMARY KEY ("id"),
  CHECK ("status" IN ('idea','decided','sent')),
  CHECK ("source" IN ('user','ai'))
);

CREATE INDEX "memories_contact_status" ON "memories" ("contact_id", "status");
CREATE INDEX "memories_recall" ON "memories" ("contact_id", "direction", "occasion");
CREATE INDEX "memories_source" ON "memories" ("source_id");
CREATE INDEX "memories_type" ON "memories" ("mem_type", "status");
CREATE INDEX "materials_contact" ON "materials" ("contact_id");
CREATE INDEX "plans_contact" ON "plans" ("contact_id", "status");

-- 素材状态派生视图（processed = 已拆出记忆）
CREATE VIEW IF NOT EXISTS "v_material_status" AS
SELECT m.*, CASE WHEN EXISTS (SELECT 1 FROM "memories" WHERE "source_id" = m."id")
                 THEN 'processed' ELSE 'raw' END AS "status"
FROM "materials" m;

-- 回礼待回应派生视图（TA 最近一次送我 > 我最近一次送出）
CREATE VIEW IF NOT EXISTS "v_gift_reciprocity" AS
SELECT c."id" AS "contact_id", c."name",
       (SELECT MAX(COALESCE(NULLIF(REPLACE("date",'每年-','0000-'),''), substr("created_at",1,10)))
          FROM "memories" WHERE "contact_id" = c."id" AND "mem_type" = 'gift' AND "status" = 'confirmed'
            AND "direction" IN ('contact_to_user','both'))          AS "last_received",
       (SELECT MAX(COALESCE(NULLIF(REPLACE("date",'每年-','0000-'),''), substr("created_at",1,10)))
          FROM "memories" WHERE "contact_id" = c."id" AND "mem_type" = 'gift' AND "status" = 'confirmed'
            AND "direction" IN ('user_to_contact','both'))          AS "last_given"
FROM "contacts" c WHERE c."archived" = 0
  AND (SELECT MAX(COALESCE(NULLIF(REPLACE("date",'每年-','0000-'),''), substr("created_at",1,10)))
          FROM "memories" WHERE "contact_id" = c."id" AND "mem_type" = 'gift' AND "status" = 'confirmed'
            AND "direction" IN ('contact_to_user','both')) IS NOT NULL
  AND ((SELECT MAX(COALESCE(NULLIF(REPLACE("date",'每年-','0000-'),''), substr("created_at",1,10)))
          FROM "memories" WHERE "contact_id" = c."id" AND "mem_type" = 'gift' AND "status" = 'confirmed'
            AND "direction" IN ('user_to_contact','both')) IS NULL
   OR (SELECT MAX(COALESCE(NULLIF(REPLACE("date",'每年-','0000-'),''), substr("created_at",1,10)))
          FROM "memories" WHERE "contact_id" = c."id" AND "mem_type" = 'gift' AND "status" = 'confirmed'
            AND "direction" IN ('contact_to_user','both'))
     > (SELECT MAX(COALESCE(NULLIF(REPLACE("date",'每年-','0000-'),''), substr("created_at",1,10)))
          FROM "memories" WHERE "contact_id" = c."id" AND "mem_type" = 'gift' AND "status" = 'confirmed'
            AND "direction" IN ('user_to_contact','both')));
