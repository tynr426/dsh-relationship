//! relstore — 联系人服务
//! created by tynan 2026-09-16

use serde_json::{json, Value as Json};
use tube::{error, Map, Value};

use deck::sqlite::Helper;
use deck::{cols, conds, DataTable, QueryExecutor, SelectExecutor, TableService};

use crate::model::{self, Contact as ContactModel};

/// 联系人服务
pub struct Contact {
    request: Value,
}

impl DataTable<ContactModel> for Contact {
    fn datasource_key(&self) -> String {
        crate::config::DATASOURCE_KEY.to_owned()
    }
}

impl TableService<ContactModel> for Contact {
    fn value(&self) -> Value {
        self.request.clone()
    }

    fn authorizer(&self) -> ((i8, u64, u64), (i8, u64), (i8, u64)) {
        ((0, 0, 0), (0, 0), (0, 0))
    }
}

/// 行 → 契约 JSON（tags 还原为数组）
pub fn contact_json(row: &Value) -> Json {
    let tags = serde_json::from_str::<Json>(&row.get_string("tags")).unwrap_or_else(|_| json!([]));
    let status = {
        let s = row.get_string("status");
        if s.is_empty() { "confirmed".to_owned() } else { s }
    };
    json!({
        "id": row.get_string("id"),
        "name": row.get_string("name"),
        "relation": row.get_string("relation"),
        "tags": if tags.is_array() { tags } else { json!([]) },
        "birthday": row.get_string("birthday"),
        "notes": row.get_string("notes"),
        "archived": row.get_i64("archived", 0) != 0,
        "status": status,
        "createdAt": row.get_string("createdAt"),
        "updatedAt": row.get_string("updatedAt"),
    })
}

impl Contact {
    /// 以请求负载构造服务（负载键为驼峰契约键）
    pub fn new(request: Value) -> Self {
        Self { request }
    }

    /// 负载中显式给出的字段（区分"未传"与"传空"）
    fn provided(val: &Value, key: &str) -> Option<String> {
        match val.get(key) {
            Some(v) if !v.is_null() => Some(v.to_string()),
            _ => None,
        }
    }

    /// 按编号解析联系人（不存在报错）
    pub fn resolve_id(&self, id: &str) -> tube::Result<String> {
        let id = id.trim();
        if id.is_empty() {
            return Err(error!("缺少联系人标识"));
        }
        let row = self.select().r#where(conds![{ "id" = id }]).one()?;
        if row.is_null() {
            return Err(error!("联系人不存在: {id}"));
        }
        Ok(row.get_string("id"))
    }

    /// 列出联系人（默认不含归档）
    pub fn list(&self, include_archived: bool) -> tube::Result<Vec<Json>> {
        let q = if include_archived {
            self.select()
        } else {
            self.select().r#where(conds![{ "archived" = 0 }])
        };
        Ok(q.order_str("name ASC").query_values()?.iter().map(contact_json).collect())
    }

    /// 单个联系人详情
    pub fn show(&self, id: &str) -> tube::Result<Json> {
        let id = self.resolve_id(id)?;
        let row = self.select().r#where(conds![{ "id" = id.as_str() }]).one()?;
        Ok(contact_json(&row))
    }

    /// 新增联系人（编号代码生成；迁移负载可携带既有 id/createdAt/updatedAt）
    pub fn add(&self) -> tube::Result<Json> {
        let val = self.value();
        let name = val.get_string("name").trim().to_owned();
        if name.is_empty() {
            return Err(error!("联系人姓名不能为空"));
        }
        let relation = {
            let r = val.get_string("relation");
            if r.is_empty() { "other".to_owned() } else { r }
        };
        // relation 必须是 relation_types 注册表中的类型（内置 + 自定义），与 JSON 版动态校验对齐
        if !super::relation_type::RelationType::exists(&relation)? {
            return Err(error!("relation 非法: {relation}"));
        }
        let status = {
            let s = val.get_string("status");
            if s.is_empty() { "confirmed".to_owned() } else { s }
        };
        if !["pending", "confirmed"].contains(&status.as_str()) {
            return Err(error!("status 非法: {status}"));
        }
        let given_id = val.get_string("id");
        let id = if given_id.is_empty() { model::uid("c") } else { given_id };
        let now = model::now();

        let data = value! {
            "id": id.clone(),
            "name": name,
            "relation": relation,
            "tags": model::parse_list(&val.get_string("tags")),
            "birthday": val.get_string("birthday"),
            "notes": val.get_string("notes"),
            "archived": 0i64,
            "status": status,
            "created_at": { let c = val.get_string("createdAt"); if c.is_empty() { now.clone() } else { c } },
            "updated_at": { let u = val.get_string("updatedAt"); if u.is_empty() { now } else { u } },
        };
        self.insert().data(&data).execute()?;
        self.show(&id)
    }

    /// 更新联系人（只覆盖传入字段）
    pub fn set(&self) -> tube::Result<Json> {
        let val = self.value();
        let id = self.resolve_id(&val.get_string("id"))?;
        let mut data = Map::new();
        for (payload_key, column) in [
            ("name", "name"),
            ("birthday", "birthday"),
            ("notes", "notes"),
        ] {
            if let Some(v) = Self::provided(&val, payload_key) {
                data.insert(column, Value::from(v));
            }
        }
        if let Some(v) = Self::provided(&val, "relation") {
            if !super::relation_type::RelationType::exists(&v)? {
                return Err(error!("relation 非法: {v}"));
            }
            data.insert("relation", Value::from(v));
        }
        if let Some(v) = Self::provided(&val, "tags") {
            data.insert("tags", Value::from(model::parse_list(&v)));
        }
        if let Some(v) = Self::provided(&val, "archived") {
            data.insert("archived", Value::from(if v == "true" { 1i64 } else { 0i64 }));
        }
        if let Some(v) = Self::provided(&val, "status") {
            if !["pending", "confirmed"].contains(&v.as_str()) {
                return Err(error!("status 非法: {v}"));
            }
            data.insert("status", Value::from(v));
        }
        if data.is_empty() {
            return Err(error!("未提供要更新的字段"));
        }
        data.insert("updated_at", Value::from(model::now()));
        self.update()
            .data(&Value::Object(data))
            .r#where(conds![{ "id" = id.as_str() }])
            .execute()?;
        self.show(&id)
    }

    /// 删除联系人：记忆/素材/计划 在单连接事务内一并级联（家法：service 层完整性）
    pub fn remove(&self, id: &str) -> tube::Result<(String, String, u64)> {
        let id = self.resolve_id(id)?;
        let row = self.select().r#where(conds![{ "id" = id.as_str() }]).one()?;
        let name = row.get_string("name");
        let conn = crate::config::relstore_connector();
        let n = Helper::executes(
            vec![
                ("DELETE FROM memories WHERE contact_id = :p1".to_owned(), vec![("p1".to_owned(), Value::from(id.as_str()))]),
                ("DELETE FROM materials WHERE contact_id = :p1".to_owned(), vec![("p1".to_owned(), Value::from(id.as_str()))]),
                ("DELETE FROM plans WHERE contact_id = :p1".to_owned(), vec![("p1".to_owned(), Value::from(id.as_str()))]),
                ("DELETE FROM contacts WHERE id = :p1".to_owned(), vec![("p1".to_owned(), Value::from(id.as_str()))]),
            ],
            &conn,
        )?;
        let removed_memories = n.first().copied().unwrap_or(0);
        Ok((id, name, removed_memories))
    }
}
