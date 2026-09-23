// 数据迁移：统一归一化三个集合（contacts / memories / materials）。
// 三个 JSON 文件 + meta.json(schemaVersion)，迁移在内存中合并执行。
export const CURRENT_SCHEMA_VERSION = 6;

function asArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} 必须是数组`);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`${name} 的元素必须是对象`);
  }
  return value;
}

export function migrateDb(rawDb) {
  if (!rawDb || typeof rawDb !== 'object' || Array.isArray(rawDb)) throw new TypeError('数据库根节点必须是对象');
  let version = Number.isInteger(rawDb.schemaVersion) ? rawDb.schemaVersion : 0;
  if (version > CURRENT_SCHEMA_VERSION) throw new Error('数据库版本过新');
  const db = {
    schemaVersion: version,
    contacts: asArray(rawDb.contacts, 'contacts'),
    memories: asArray(rawDb.memories, 'memories'),
    materials: asArray(rawDb.materials, 'materials'),
    plans: asArray(rawDb.plans, 'plans'),
  };
  if (version < 1) {
    for (const c of db.contacts) {
      c.id = String(c.id || '');
      c.name = String(c.name || '');
      c.relation = c.relation || 'other';
      c.tags = Array.isArray(c.tags) ? c.tags.map(String) : [];
      c.birthday = typeof c.birthday === 'string' ? c.birthday : '';
      c.notes = typeof c.notes === 'string' ? c.notes : '';
      c.archived = Boolean(c.archived);
      c.createdAt = c.createdAt || '';
      c.updatedAt = c.updatedAt || '';
    }
    for (const m of db.memories) {
      m.id = String(m.id || '');
      m.contactId = String(m.contactId || '');
      m.type = m.type || 'interaction';
      m.content = String(m.content || '');
      m.date = typeof m.date === 'string' ? m.date : '';
      m.importance = Number.isInteger(m.importance) ? m.importance : 2;
      m.sourceId = typeof m.sourceId === 'string' ? m.sourceId : '';
      m.author = m.author === 'user' ? 'user' : 'ai';
      m.status = ['pending', 'confirmed', 'rejected'].includes(m.status) ? m.status : 'pending';
      m.reason = typeof m.reason === 'string' ? m.reason : '';
      m.createdAt = m.createdAt || '';
      m.confirmedAt = m.confirmedAt || null;
      m.updatedAt = m.updatedAt || '';
      m.supersededBy = typeof m.supersededBy === 'string' ? m.supersededBy : null;
    }
    for (const mt of db.materials) {
      mt.id = String(mt.id || '');
      mt.kind = mt.kind === 'screenshot' || mt.kind === 'file' ? mt.kind : 'text';
      mt.text = typeof mt.text === 'string' ? mt.text : '';
      mt.excerpt = typeof mt.excerpt === 'string' ? mt.excerpt : '';
      mt.capturedAt = mt.capturedAt || '';
      mt.extractedMemoryIds = Array.isArray(mt.extractedMemoryIds) ? mt.extractedMemoryIds.map(String) : [];
    }
    version = 1;
    db.schemaVersion = version;
  }
  if (version < 2) {
    // v2：素材可关联到某个联系人（用户粘贴整理时选择，AI 提取时作为默认对象）
    for (const mt of db.materials) {
      mt.contactId = typeof mt.contactId === 'string' ? mt.contactId : '';
    }
    version = 2;
    db.schemaVersion = version;
  }
  if (version < 3) {
    // v3：记忆新增话语时间 saidAt——一对一聊天素材带时间戳时记录
    // "这段话是什么时候说的"，与事实发生时间 date 区分。
    for (const m of db.memories) {
      m.saidAt = typeof m.saidAt === 'string' ? m.saidAt : '';
    }
    version = 3;
    db.schemaVersion = version;
  }
  if (version < 4) {
    // v4（表达历史三层）：direction 表达方向（user_to_contact / contact_to_user / both），
    // lifespan 记忆寿命（long 默认 / short 当前场景有效的临时事项），
    // occasion 场景标签（自由小写标签，素材与记忆都有；提取时继承）。
    for (const m of db.memories) {
      m.direction = ['user_to_contact', 'contact_to_user', 'both'].includes(m.direction) ? m.direction : '';
      m.lifespan = m.lifespan === 'short' ? 'short' : 'long';
      m.occasion = typeof m.occasion === 'string' ? m.occasion.toLowerCase().replace(/\s+/g, '_').slice(0, 40) : '';
    }
    for (const mt of db.materials) {
      mt.occasion = typeof mt.occasion === 'string' ? mt.occasion.toLowerCase().replace(/\s+/g, '_').slice(0, 40) : '';
    }
    version = 4;
    db.schemaVersion = version;
  }
  if (version < 5) {
    // v5：新增礼物计划集合 plans——送礼工作流（想法 → 已定 → 已送）。
    // 计划是低风险意图，不进待确认队列；标"已送"时自动生成一条已确认的
    // gift 记忆（author=user），完成"计划 → 台账 → 时间线 → 明年去重"闭环。
    for (const p of db.plans) {
      p.id = String(p.id || '');
      p.contactId = String(p.contactId || '');
      p.occasion = typeof p.occasion === 'string' ? p.occasion.toLowerCase().replace(/\s+/g, '_').slice(0, 40) : '';
      p.occasionDate = typeof p.occasionDate === 'string' ? p.occasionDate : '';
      p.idea = String(p.idea || '');
      p.budget = String(p.budget || '');
      // 真实商品三字段：v1 手动贴链接；未来接选品接口后由接口自动回填，字段不变
      p.productName = typeof p.productName === 'string' ? p.productName.slice(0, 100) : '';
      p.productPrice = typeof p.productPrice === 'string' ? p.productPrice.slice(0, 40) : '';
      p.productUrl = typeof p.productUrl === 'string' ? p.productUrl.slice(0, 500) : '';
      p.status = ['idea', 'decided', 'sent', 'done'].includes(p.status) ? p.status : 'idea';
      p.sentAt = typeof p.sentAt === 'string' ? p.sentAt : '';
      p.memoryId = typeof p.memoryId === 'string' ? p.memoryId : '';
      p.source = p.source === 'ai' ? 'ai' : 'user';
      p.createdAt = p.createdAt || '';
      p.updatedAt = p.updatedAt || '';
    }
    version = 5;
    db.schemaVersion = version;
  }
  if (version < 6) {
    // v6：联系人收录状态——AI 新建一律 pending，工作台拍板转正后才算正式联系人。
    // 存量数据全部视为已收录（confirmed）。
    for (const c of db.contacts) {
      c.status = c.status === 'pending' ? 'pending' : 'confirmed';
    }
    version = 6;
    db.schemaVersion = version;
  }
  return db;
}
