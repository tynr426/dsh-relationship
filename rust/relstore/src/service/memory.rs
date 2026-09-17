//! relstore — 记忆服务（核心表）
//! created by tynan 2026-09-16

use serde_json::{json, Value as Json};
use tube::{error, Map, Value};

use deck::sqlite::Helper;
use deck::{conds, DataTable, QueryExecutor, SelectExecutor, TableService};

use crate::model::{self, Memory as MemoryModel};
use crate::service::contact::Contact;

/// 记忆服务
pub struct Memory {
    request: Value,
}

impl DataTable<MemoryModel> for Memory {
    fn datasource_key(&self) -> String {
        crate::config::DATASOURCE_KEY.to_owned()
    }
}

impl TableService<MemoryModel> for Memory {
    fn value(&self) -> Value {
        self.request.clone()
    }

    fn authorizer(&self) -> ((i8, u64, u64), (i8, u64), (i8, u64)) {
        ((0, 0, 0), (0, 0), (0, 0))
    }
}

/// 行 → 契约 JSON（键与工作台 REST 完全一致）
pub fn memory_json(row: &Value) -> Json {
    json!({
        "id": row.get_string("id"),
        "contactId": row.get_string("contactId"),
        "type": row.get_string("type"),
        "content": row.get_string("content"),
        "date": row.get_string("date"),
        "saidAt": row.get_string("saidAt"),
        "importance": row.get_i64("importance", 2),
        "direction": row.get_string("direction"),
        "lifespan": row.get_string("lifespan"),
        "occasion": row.get_string("occasion"),
        "sourceId": row.get_string("sourceId"),
        "author": row.get_string("author"),
        "status": row.get_string("status"),
        "reason": row.get_string("reason"),
        "supersededBy": row.get_string("supersededBy"),
        "confirmedAt": row.get_string("confirmedAt"),
        "createdAt": row.get_string("createdAt"),
        "updatedAt": row.get_string("updatedAt"),
    })
}

/// 记忆类型与状态枚举（与 JSON 版 / DDL CHECK 一致）
pub const MEMORY_TYPES: [&str; 8] = [
    "preference", "dislike", "taboo", "event", "gift", "promise", "interaction", "attribute",
];
const DIRECTIONS: [&str; 4] = ["", "user_to_contact", "contact_to_user", "both"];

impl Memory {
    pub fn new(request: Value) -> Self {
        Self { request }
    }

    /// 按编号解析记忆（不存在报错）
    pub fn resolve_id(&self, id: &str) -> tube::Result<String> {
        let id = id.trim();
        if id.is_empty() {
            return Err(error!("缺少记忆编号"));
        }
        let row = self.select().r#where(conds![{ "id" = id }]).one()?;
        if row.is_null() {
            return Err(error!("记忆不存在: {id}"));
        }
        Ok(row.get_string("id"))
    }

    /// 列表 + 过滤（contact/status/type/direction/occasion/lifespan/q 关键字）
    pub fn list(&self) -> tube::Result<Vec<Json>> {
        let val = self.value();
        let mut q = self.select();
        let contact = val.get_string("contactId");
        if !contact.is_empty() {
            q = q.r#where(conds![{ "contact_id" = contact.as_str() }]);
        }
        let status = val.get_string("status");
        if !status.is_empty() {
            q = q.r#where(conds![{ "status" = status.as_str() }]);
        }
        let r#type = val.get_string("type");
        if !r#type.is_empty() {
            q = q.r#where(conds![{ "type" = r#type.as_str() }]);
        }
        let direction = val.get_string("direction");
        if !direction.is_empty() {
            q = q.r#where(conds![{ "direction" = direction.as_str() }]);
        }
        let occasion = val.get_string("occasion");
        if !occasion.is_empty() {
            q = q.r#where(conds![{ "occasion" = occasion.as_str() }]);
        }
        let lifespan = val.get_string("lifespan");
        if !lifespan.is_empty() {
            q = q.r#where(conds![{ "lifespan" = lifespan.as_str() }]);
        }
        let q_kw = val.get_string("q");
        if !q_kw.is_empty() {
            q = q.r#where(conds![{ "content" % format!("%{q_kw}%") }]);
        }
        Ok(q.order_str("created_at DESC").query_values()?.iter().map(memory_json).collect())
    }

    /// 新增记忆（AI 一律 pending；author=user 即 confirmed）
    pub fn add(&self) -> tube::Result<Json> {
        let val = self.value();
        let contact_id = val.get_string("contactId");
        if Contact::new(Value::Null).resolve_id(&contact_id).is_err() {
            return Err(error!("联系人不存在: {contact_id}"));
        }
        let r#type = val.get_string("type");
        if r#type.is_empty() {
            return Err(error!("type 必填"));
        }
        if !MEMORY_TYPES.contains(&r#type.as_str()) {
            let t = r#type.clone();
            return Err(error!("type 非法: {t}"));
        }
        let content = val.get_string("content").trim().to_owned();
        if content.is_empty() {
            return Err(error!("content 不能为空"));
        }
        let author = {
            let a = val.get_string("author");
            if a.is_empty() { "ai".to_owned() } else { a }
        };
        if !["user", "ai"].contains(&author.as_str()) {
            return Err(error!("author 非法: {author}"));
        }
        let direction = val.get_string("direction");
        if !DIRECTIONS.contains(&direction.as_str()) {
            return Err(error!("direction 非法: {direction}"));
        }
        let lifespan = {
            let l = val.get_string("lifespan");
            if l.is_empty() { "long".to_owned() } else { l }
        };
        if !["long", "short"].contains(&lifespan.as_str()) {
            return Err(error!("lifespan 非法: {lifespan}"));
        }
        let importance = val.get_i64("importance", 2).clamp(1, 3);
        // 状态：迁移路径显式携带（老数据 author=ai 也可能已被用户确认），API 路径按 author 推导
        let given_status = val.get_string("status");
        let status = if ["pending", "confirmed", "rejected"].contains(&given_status.as_str()) {
            given_status
        } else if author == "user" {
            "confirmed".to_owned()
        } else {
            "pending".to_owned()
        };
        let now = model::now();
        let id = { let g = val.get_string("id"); if g.is_empty() { model::uid("m") } else { g } };

        let data = value! {
            "id": id.clone(),
            "contact_id": contact_id,
            "type": r#type,
            "content": content,
            "date": val.get_string("date"),
            "said_at": val.get_string("saidAt"),
            "importance": importance,
            "direction": direction,
            "lifespan": lifespan,
            "occasion": model::normalize_occasion(&val.get_string("occasion")),
            "source_id": val.get_string("sourceId"),
            "author": author,
            "status": status.clone(),
            "reason": val.get_string("reason"),
            "superseded_by": val.get_string("supersededBy"),
            "confirmed_at": { if status == "confirmed" { let c = val.get_string("confirmedAt"); if c.is_empty() { now.clone() } else { c } } else { "".to_owned() } },
            "created_at": { let c = val.get_string("createdAt"); if c.is_empty() { now.clone() } else { c } },
            "updated_at": { let u = val.get_string("updatedAt"); if u.is_empty() { now } else { u } },
        };
        self.insert().data(&data).execute()?;
        self.one(&id)
    }

    /// 单条详情
    pub fn one(&self, id: &str) -> tube::Result<Json> {
        let row = self.select().r#where(conds![{ "id" = id }]).one()?;
        if row.is_null() {
            return Err(error!("记忆不存在: {id}"));
        }
        Ok(memory_json(&row))
    }

    /// 更新记忆（只覆盖传入字段；编辑 pending/confirmed 用，可携带 status 变更）
    pub fn set(&self) -> tube::Result<Json> {
        let val = self.value();
        let id = self.resolve_id(&val.get_string("id"))?;
        let row = self.select().r#where(conds![{ "id" = id.as_str() }]).one()?;
        let mut data = Map::new();
        if let Some(v) = Self::provided(&val, "status") {
            if !["pending", "confirmed", "rejected"].contains(&v.as_str()) {
                return Err(error!("status 非法: {v}"));
            }
            data.insert("status", Value::from(v.clone()));
            if v == "confirmed" && row.get_string("confirmedAt").is_empty() {
                data.insert("confirmed_at", Value::from(model::now()));
            }
            if v == "rejected" {
                if let Some(r) = Self::provided(&val, "reason") {
                    data.insert("reason", Value::from(r));
                }
            }
        }
        if let Some(v) = Self::provided(&val, "content") {
            data.insert("content", Value::from(v.trim().to_owned()));
        }
        for (payload_key, column) in [("date", "date"), ("saidAt", "said_at"), ("occasion", "occasion")] {
            if let Some(v) = Self::provided(&val, payload_key) {
                let v = if payload_key == "occasion" { model::normalize_occasion(&v) } else { v };
                data.insert(column, Value::from(v));
            }
        }
        if let Some(v) = Self::provided(&val, "type") {
            data.insert("type", Value::from(v));
        }
        if let Some(v) = Self::provided(&val, "direction") {
            data.insert("direction", Value::from(v));
        }
        if let Some(v) = Self::provided(&val, "lifespan") {
            data.insert("lifespan", Value::from(v));
        }
        if let Some(v) = Self::provided(&val, "importance") {
            let n: i64 = v.parse().unwrap_or(2);
            data.insert("importance", Value::from(n.clamp(1, 3)));
        }
        if data.is_empty() {
            return Err(error!("未提供要更新的字段"));
        }
        data.insert("updated_at", Value::from(model::now()));
        self.update()
            .data(&Value::Object(data))
            .r#where(conds![{ "id" = id.as_str() }])
            .execute()?;
        self.one(&id)
    }

    /// 批量确认（用户明确确认后才可调用）
    pub fn confirm(ids: &[String]) -> tube::Result<Vec<Json>> {
        let mut out = Vec::new();
        let conn = crate::config::relstore_connector();
        for id in ids {
            let now = model::now();
            Helper::executes(
                vec![(
                    "UPDATE memories SET status='confirmed', confirmed_at=:p1, updated_at=:p1 WHERE id=:p2"
                        .to_owned(),
                    vec![
                        ("p1".to_owned(), Value::from(now.as_str())),
                        ("p2".to_owned(), Value::from(id.as_str())),
                    ],
                )],
                &conn,
            )?;
            out.push(Memory::new(Value::Null).one(id)?);
        }
        Ok(out)
    }

    /// 驳回
    pub fn reject(id: &str, reason: &str) -> tube::Result<Json> {
        let conn = crate::config::relstore_connector();
        let now = model::now();
        Helper::executes(
            vec![(
                "UPDATE memories SET status='rejected', reason=:p1, updated_at=:p2 WHERE id=:p3".to_owned(),
                vec![
                    ("p1".to_owned(), Value::from(reason)),
                    ("p2".to_owned(), Value::from(now.as_str())),
                    ("p3".to_owned(), Value::from(id)),
                ],
            )],
            &conn,
        )?;
        Memory::new(Value::Null).one(id)
    }

    /// 恢复（rejected → pending，清驳回原因）
    pub fn restore(id: &str) -> tube::Result<Json> {
        let conn = crate::config::relstore_connector();
        let now = model::now();
        Helper::executes(
            vec![(
                "UPDATE memories SET status='pending', reason='', updated_at=:p1 WHERE id=:p2 AND status='rejected'".to_owned(),
                vec![
                    ("p1".to_owned(), Value::from(now.as_str())),
                    ("p2".to_owned(), Value::from(id)),
                ],
            )],
            &conn,
        )?;
        Memory::new(Value::Null).one(id)
    }

    /// 标记被取代（supersededBy 指向保留的记忆；不能指向自身）
    pub fn supersede(id: &str, keep_id: &str) -> tube::Result<Json> {
        if id == keep_id {
            return Err(error!("不能指向自身"));
        }
        let conn = crate::config::relstore_connector();
        let now = model::now();
        Helper::executes(
            vec![(
                "UPDATE memories SET superseded_by=:p1, updated_at=:p2 WHERE id=:p3".to_owned(),
                vec![
                    ("p1".to_owned(), Value::from(keep_id)),
                    ("p2".to_owned(), Value::from(now.as_str())),
                    ("p3".to_owned(), Value::from(id)),
                ],
            )],
            &conn,
        )?;
        Memory::new(Value::Null).one(id)
    }

    /// 删除单条
    pub fn remove(id: &str) -> tube::Result<()> {
        let conn = crate::config::relstore_connector();
        Helper::executes(
            vec![(
                "DELETE FROM memories WHERE id=:p1".to_owned(),
                vec![("p1".to_owned(), Value::from(id))],
            )],
            &conn,
        )?;
        Ok(())
    }

    /// 负载中显式给出的字段
    fn provided(val: &Value, key: &str) -> Option<String> {
        match val.get(key) {
            Some(v) if !v.is_null() => Some(v.to_string()),
            _ => None,
        }
    }
}
