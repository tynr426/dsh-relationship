//! relstore — 礼物计划服务
//! plan sent：单连接事务内「更新计划 + 插入 gift 记忆」（Helper::executes 家法原子性）
//! created by tynan 2026-09-16

use serde_json::{json, Value as Json};
use tube::{error, Map, Value};

use deck::sqlite::Helper;
use deck::{conds, DataTable, QueryExecutor, SelectExecutor, TableService};

use crate::model::{self, Plan as PlanModel};

const PLAN_STATUSES: [&str; 4] = ["idea", "decided", "sent", "done"];

/// 计划服务
pub struct Plan {
    request: Value,
}

impl DataTable<PlanModel> for Plan {
    fn datasource_key(&self) -> String {
        crate::config::DATASOURCE_KEY.to_owned()
    }
}

impl TableService<PlanModel> for Plan {
    fn value(&self) -> Value {
        self.request.clone()
    }

    fn authorizer(&self) -> ((i8, u64, u64), (i8, u64), (i8, u64)) {
        ((0, 0, 0), (0, 0), (0, 0))
    }
}

/// 行 → 契约 JSON
pub fn plan_json(row: &Value) -> Json {
    json!({
        "id": row.get_string("id"),
        "contactId": row.get_string("contactId"),
        "occasion": row.get_string("occasion"),
        "occasionDate": row.get_string("occasionDate"),
        "idea": row.get_string("idea"),
        "budget": row.get_string("budget"),
        "productName": row.get_string("productName"),
        "productPrice": row.get_string("productPrice"),
        "productUrl": row.get_string("productUrl"),
        "status": row.get_string("status"),
        "sentAt": row.get_string("sentAt"),
        "memoryId": row.get_string("memoryId"),
        "source": row.get_string("source"),
        "createdAt": row.get_string("createdAt"),
        "updatedAt": row.get_string("updatedAt"),
    })
}

impl Plan {
    pub fn new(request: Value) -> Self {
        Self { request }
    }

    /// 负载中显式给出的字段
    fn provided(val: &Value, key: &str) -> Option<String> {
        match val.get(key) {
            Some(v) if !v.is_null() => Some(v.to_string()),
            _ => None,
        }
    }

    /// 按编号解析计划
    pub fn resolve_id(&self, id: &str) -> tube::Result<String> {
        let id = id.trim();
        if id.is_empty() {
            return Err(error!("缺少计划编号"));
        }
        let row = self.select().r#where(conds![{ "id" = id }]).one()?;
        if row.is_null() {
            return Err(error!("计划不存在: {id}"));
        }
        Ok(row.get_string("id"))
    }

    /// 列出计划（contact/status 过滤），按更新时间倒序。
    /// 同 memory.list：r#where 整体替换，多条件拼同一个 Vec 一次传入。
    pub fn list(&self) -> tube::Result<Vec<Json>> {
        let val = self.value();
        let mut conds: Vec<deck::Condition> = Vec::new();
        let contact = val.get_string("contactId");
        if !contact.is_empty() {
            conds.extend(conds![{ "contact_id" = contact.as_str() }]);
        }
        let status = val.get_string("status");
        if !status.is_empty() {
            conds.extend(conds![{ "status" = status.as_str() }]);
        }
        let q = self.select();
        let q = if conds.is_empty() { q } else { q.r#where(conds) };
        Ok(q.order_str("updated_at DESC").query_values()?.iter().map(plan_json).collect())
    }

    /// 单条详情
    pub fn one(&self, id: &str) -> tube::Result<Json> {
        let row = self.select().r#where(conds![{ "id" = id }]).one()?;
        if row.is_null() {
            return Err(error!("计划不存在: {id}"));
        }
        Ok(plan_json(&row))
    }

    /// 新增计划（idea 必填；occasionDate 必须 YYYY-MM-DD 或空；productUrl 必须 http(s) 开头）
    pub fn add(&self) -> tube::Result<Json> {
        let val = self.value();
        let contact_id = val.get_string("contactId");
        if crate::service::contact::Contact::new(Value::Null).resolve_id(&contact_id).is_err() {
            return Err(error!("联系人不存在: {contact_id}"));
        }
        let idea = val.get_string("idea").trim().to_owned();
        if idea.is_empty() {
            return Err(error!("礼物想法不能为空"));
        }
        if idea.chars().count() > 200 {
            return Err(error!("礼物想法不能超过 200 字"));
        }
        let occasion_date = val.get_string("occasionDate");
        if !occasion_date.is_empty()
            && (occasion_date.len() != 10 || occasion_date.split('-').count() != 3)
        {
            return Err(error!("occasionDate 必须是 YYYY-MM-DD（这一次的具体日期）"));
        }
        let product_url = val.get_string("productUrl").trim().to_owned();
        if product_url.encode_utf16().count() > 4096 {
            return Err(error!("商品链接不能超过 4096 字"));
        }
        if !product_url.is_empty()
            && !product_url.to_lowercase().starts_with("http://")
            && !product_url.to_lowercase().starts_with("https://")
            && !product_url.to_lowercase().starts_with("//")
        {
            return Err(error!("商品链接要以 http(s):// 开头"));
        }
        let source = {
            let s = val.get_string("source");
            if s.is_empty() { "user".to_owned() } else { s }
        };
        if !["user", "ai"].contains(&source.as_str()) {
            return Err(error!("source 非法: {source}"));
        }
        let status = {
            let s = val.get_string("status");
            if s.is_empty() { "idea".to_owned() } else { s }
        };
        if !PLAN_STATUSES.contains(&status.as_str()) {
            return Err(error!("status 必须是：idea / decided / sent / done"));
        }
        let now = model::now();
        let id = { let g = val.get_string("id"); if g.is_empty() { model::uid("gp") } else { g } };
        // 迁移路径：sent 计划要保留 sentAt / memoryId / 时间戳；API 路径这些键不传，走默认
        let sent_at = val.get_string("sentAt");
        let memory_id = val.get_string("memoryId");
        let data = value! {
            "id": id.clone(),
            "contact_id": contact_id,
            "occasion": model::normalize_occasion(&val.get_string("occasion")),
            "occasion_date": occasion_date,
            "idea": idea,
            "budget": val.get_string("budget").trim().chars().take(40).collect::<String>(),
            "product_name": val.get_string("productName").trim().chars().take(100).collect::<String>(),
            "product_price": val.get_string("productPrice").trim().chars().take(40).collect::<String>(),
            "product_url": product_url,
            "status": status,
            "sent_at": sent_at,
            "memory_id": memory_id,
            "source": source,
            "created_at": { let c = val.get_string("createdAt"); if c.is_empty() { now.clone() } else { c } },
            "updated_at": { let u = val.get_string("updatedAt"); if u.is_empty() { now } else { u } },
        };
        self.insert().data(&data).execute()?;
        self.one(&id)
    }

    /// 更新计划（只覆盖传入字段）
    pub fn set(&self) -> tube::Result<Json> {
        let val = self.value();
        let id = self.resolve_id(&val.get_string("id"))?;
        let current = self.one(&id)?;
        let current_status = current["status"].as_str().unwrap_or_default();
        let mut data = Map::new();
        for (payload_key, column, cap) in [
            ("idea", "idea", 200usize),
            ("budget", "budget", 40),
            ("productName", "product_name", 100),
            ("productPrice", "product_price", 40),
            ("productUrl", "product_url", 4096),
        ] {
            if let Some(v) = Self::provided(&val, payload_key) {
                let v = v.trim();
                if payload_key == "productUrl" {
                    if v.encode_utf16().count() > 4096 {
                        return Err(error!("商品链接不能超过 4096 字"));
                    }
                    let lower = v.to_lowercase();
                    if !v.is_empty() && !lower.starts_with("http://") && !lower.starts_with("https://") && !lower.starts_with("//") {
                        return Err(error!("商品链接要以 http(s):// 开头"));
                    }
                    data.insert(column, Value::from(v.to_owned()));
                } else {
                    data.insert(column, Value::from(v.chars().take(cap).collect::<String>()));
                }
            }
        }
        if let Some(v) = Self::provided(&val, "occasion") {
            data.insert("occasion", Value::from(model::normalize_occasion(&v)));
        }
        if let Some(v) = Self::provided(&val, "occasionDate") {
            if !v.is_empty() && (v.len() != 10 || v.split('-').count() != 3) {
                return Err(error!("occasionDate 必须是 YYYY-MM-DD（这一次的具体日期）"));
            }
            data.insert("occasion_date", Value::from(v));
        }
        if let Some(v) = Self::provided(&val, "status") {
            if !PLAN_STATUSES.contains(&v.as_str()) {
                return Err(error!("status 必须是：idea / decided / sent / done"));
            }
            if ["sent", "done"].contains(&current_status) && v != current_status {
                return Err(error!("已终结的计划不能更改状态"));
            }
            // 普通完成重试不刷新完成时间；仍允许修正文案等字段。
            if v == "done" && current_status == "done" && data.is_empty() {
                return Ok(current);
            }
            data.insert("status", Value::from(v.clone()));
            if v == "sent" && current["sentAt"].as_str().unwrap_or_default().is_empty() {
                data.insert("sent_at", Value::from(model::now()));
            }
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

    /// 标记已送：单连接事务内「计划置 sent + 插入已确认 gift 记忆」；已送过的直接返回（幂等）
    pub fn mark_sent(&self, id: &str) -> tube::Result<Json> {
        let row = self.select().r#where(conds![{ "id" = id }]).one()?;
        if row.is_null() {
            return Err(error!("计划不存在: {id}"));
        }
        let plan = plan_json(&row);
        if plan["status"].as_str() == Some("done") {
            return Err(error!("已完成的计划不能标记已送出"));
        }
        let existing = plan["memoryId"].as_str().unwrap_or_default();
        if !existing.is_empty() {
            let mem = Memory::new(Value::Null).one(existing);
            return match mem {
                Ok(m) => Ok(json!({ "ok": true, "plan": plan, "memory": m })),
                Err(_) => Ok(json!({ "ok": true, "plan": plan, "memory": Json::Null })),
            };
        }
        let contact_id = plan["contactId"].as_str().unwrap_or_default().to_owned();
        if crate::service::contact::Contact::new(Value::Null).resolve_id(&contact_id).is_err() {
            return Err(error!("联系人不存在: {contact_id}"));
        }

        // 组装 gift 记忆内容（与 JSON 版一致：商品名优先，想法/价格入括注）
        let product_name = plan["productName"].as_str().unwrap_or_default().to_owned();
        let idea = plan["idea"].as_str().unwrap_or_default().to_owned();
        let product_price = plan["productPrice"].as_str().unwrap_or_default().to_owned();
        let primary = if product_name.is_empty() { idea.clone() } else { product_name.clone() };
        let mut detail: Vec<String> = Vec::new();
        if !product_name.is_empty() && !idea.is_empty() && idea != product_name {
            detail.push(idea.clone());
        }
        if !product_price.is_empty() {
            detail.push(format!("¥{product_price}"));
        }
        let mut content = format!("送出礼物：{primary}");
        if !detail.is_empty() {
            content.push_str(&format!("（{}）", detail.join("，")));
        }
        let occasion = plan["occasion"].as_str().unwrap_or_default().to_owned();
        if !occasion.is_empty() {
            content.push_str(&format!("（{occasion}）"));
        }
        let budget = plan["budget"].as_str().unwrap_or_default().to_owned();
        if !budget.is_empty() && product_price.is_empty() {
            content.push_str(&format!("预算 {budget}"));
        }

        let memory_id = model::uid("m");
        let now = model::now();
        let today = model::today();
        let conn = crate::config::relstore_connector();
        Helper::executes(
            vec![
                (
                    "INSERT INTO memories (id, contact_id, mem_type, content, date, said_at, importance, direction, lifespan, occasion, source_id, author, status, reason, superseded_by, confirmed_at, created_at, updated_at) VALUES (:p1,:p2,'gift',:p3,:p4,'',2,'user_to_contact','long',:p5,'','user','confirmed','','',:p6,:p6,:p6)".to_owned(),
                    vec![
                        ("p1".to_owned(), Value::from(memory_id.as_str())),
                        ("p2".to_owned(), Value::from(contact_id.as_str())),
                        ("p3".to_owned(), Value::from(content.as_str())),
                        ("p4".to_owned(), Value::from(today.as_str())),
                        ("p5".to_owned(), Value::from(occasion.as_str())),
                        ("p6".to_owned(), Value::from(now.as_str())),
                    ],
                ),
                (
                    "UPDATE plans SET status='sent', sent_at=:p1, memory_id=:p2, updated_at=:p1 WHERE id=:p3".to_owned(),
                    vec![
                        ("p1".to_owned(), Value::from(now.as_str())),
                        ("p2".to_owned(), Value::from(memory_id.as_str())),
                        ("p3".to_owned(), Value::from(id)),
                    ],
                ),
            ],
            &conn,
        )
        .map_err(|e| error!("标记已送失败: {e}"))?;

        Ok(json!({ "ok": true, "plan": self.one(id)?, "memory": Memory::new(Value::Null).one(&memory_id)? }))
    }

    /// 删除计划（关联记忆保留——礼物已送出是事实）
    pub fn remove(id: &str) -> tube::Result<()> {
        let conn = crate::config::relstore_connector();
        Helper::executes(
            vec![(
                "DELETE FROM plans WHERE id=:p1".to_owned(),
                vec![("p1".to_owned(), Value::from(id))],
            )],
            &conn,
        )?;
        Ok(())
    }
}

use crate::service::memory::Memory;
