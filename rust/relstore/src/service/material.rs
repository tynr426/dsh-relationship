//! relstore — 素材服务（状态由 v_material_status 视图派生）
//! created by tynan 2026-09-16

use serde_json::{json, Value as Json};
use tube::{error, Value};

use deck::sqlite::{DataRow, Helper};
use deck::{conds, DataTable, QueryExecutor, SelectExecutor, TableService};

use crate::model::{self, Material as MaterialModel};

/// 素材服务
pub struct Material {
    request: Value,
}

impl DataTable<MaterialModel> for Material {
    fn datasource_key(&self) -> String {
        crate::config::DATASOURCE_KEY.to_owned()
    }
}

impl TableService<MaterialModel> for Material {
    fn value(&self) -> Value {
        self.request.clone()
    }

    fn authorizer(&self) -> ((i8, u64, u64), (i8, u64), (i8, u64)) {
        ((0, 0, 0), (0, 0), (0, 0))
    }
}

/// 行 → 契约 JSON（status 为派生键；extractedMemoryIds 由 Node 侧按需反查）
pub fn material_json(row: &Value, status: &str) -> Json {
    json!({
        "id": row.get_string("id"),
        "kind": row.get_string("kind"),
        "text": row.get_string("text"),
        "excerpt": row.get_string("excerpt"),
        "contactId": row.get_string("contactId"),
        "occasion": row.get_string("occasion"),
        "capturedAt": row.get_string("capturedAt"),
        "status": status,
    })
}

/// 视图行 → 契约 JSON（DataRow 只支持索引取值，列序与 SELECT 显式清单一致）
fn view_rows(conn: &deck::Connector, sql: &str) -> tube::Result<Vec<Json>> {
    let rows = Helper::query(
        sql,
        vec![],
        move |r, _: &Option<Vec<deck::Attribute>>| {
            (0..8).map(|i| r.get_string(i)).collect::<Vec<String>>()
        },
        conn,
        &None,
    )
    .map_err(|e| error!("查素材失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r[0], "kind": r[1], "text": r[2], "excerpt": r[3],
                "contactId": r[4], "occasion": r[5], "capturedAt": r[6], "status": r[7],
            })
        })
        .collect())
}

impl Material {
    pub fn new(request: Value) -> Self {
        Self { request }
    }

    /// 按编号解析素材
    pub fn resolve_id(&self, id: &str) -> tube::Result<String> {
        let id = id.trim();
        if id.is_empty() {
            return Err(error!("缺少素材编号"));
        }
        let row = self.select().r#where(conds![{ "id" = id }]).one()?;
        if row.is_null() {
            return Err(error!("素材不存在: {id}"));
        }
        Ok(row.get_string("id"))
    }

    /// 列出素材（--status raw|processed 走视图过滤），按存档时间倒序
    pub fn list(&self) -> tube::Result<Vec<Json>> {
        let val = self.value();
        let status = val.get_string("status");
        let conn = crate::config::relstore_connector();
        let sql = if status.is_empty() {
            "SELECT id, kind, text, excerpt, contact_id, occasion, captured_at, status FROM v_material_status ORDER BY captured_at DESC".to_owned()
        } else {
            format!("SELECT id, kind, text, excerpt, contact_id, occasion, captured_at, status FROM v_material_status WHERE status='{status}' ORDER BY captured_at DESC")
        };
        let rows = view_rows(&conn, &sql)?;
        Ok(rows)
    }

    /// 存档素材（原文 + 摘要 + 场景；contactId 可空）
    pub fn add(&self) -> tube::Result<Json> {
        let val = self.value();
        let text = val.get_string("text");
        if text.trim().is_empty() {
            return Err(error!("素材内容不能为空"));
        }
        if text.chars().count() > 200_000 {
            return Err(error!("素材过长（上限 20 万字符）"));
        }
        let contact_id = val.get_string("contactId");
        if !contact_id.is_empty() && crate::service::contact::Contact::new(Value::Null).resolve_id(&contact_id).is_err() {
            return Err(error!("关联的联系人不存在: {contact_id}"));
        }
        let excerpt: String = text.chars().take(120).collect();
        let id = { let g = val.get_string("id"); if g.is_empty() { model::uid("mt") } else { g } };
        let data = value! {
            "id": id.clone(),
            "kind": { let k = val.get_string("kind"); if ["screenshot", "file"].contains(&k.as_str()) { k } else { "text".to_owned() } },
            "text": text,
            "excerpt": excerpt,
            "contact_id": contact_id,
            "occasion": model::normalize_occasion(&val.get_string("occasion")),
            "captured_at": { let c = val.get_string("capturedAt"); if c.is_empty() { model::now() } else { c } },
        };
        self.insert().data(&data).execute()?;
        self.one(&id)
    }

    /// 单条详情（带派生状态）
    pub fn one(&self, id: &str) -> tube::Result<Json> {
        self.resolve_id(id)?;
        let conn = crate::config::relstore_connector();
        let sql = format!("SELECT id, kind, text, excerpt, contact_id, occasion, captured_at, status FROM v_material_status WHERE id='{id}'");
        let mut rows = view_rows(&conn, &sql)?;
        rows.pop().ok_or_else(|| error!("素材不存在: {id}"))
    }

    /// 关联记忆（回写记忆 source_id；素材状态随之派生为 processed）
    pub fn link(id: &str, memory_id: &str) -> tube::Result<Json> {
        Material::new(Value::Null).resolve_id(id)?;
        if crate::service::memory::Memory::new(Value::Null).resolve_id(memory_id).is_err() {
            return Err(error!("记忆不存在: {memory_id}"));
        }
        let conn = crate::config::relstore_connector();
        let now = model::now();
        Helper::executes(
            vec![(
                "UPDATE memories SET source_id=:p1, updated_at=:p2 WHERE id=:p3".to_owned(),
                vec![
                    ("p1".to_owned(), Value::from(id)),
                    ("p2".to_owned(), Value::from(now.as_str())),
                    ("p3".to_owned(), Value::from(memory_id)),
                ],
            )],
            &conn,
        )?;
        Material::new(Value::Null).one(id)
    }

    /// 删除素材（已拆出的记忆不受影响——source_id 保留原文编号仅作历史线索）
    pub fn remove(id: &str) -> tube::Result<()> {
        let conn = crate::config::relstore_connector();
        Helper::executes(
            vec![(
                "DELETE FROM materials WHERE id=?1".to_owned(),
                vec![("1".to_owned(), Value::from(id))],
            )],
            &conn,
        )?;
        Ok(())
    }
}
