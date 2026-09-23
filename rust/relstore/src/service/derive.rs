//! relstore — 派生服务：送礼台账 / 回礼待回应 / 送礼时机
//! reciprocity 直接读视图；occasion 的日期数学留在 Rust（每年循环 + 标签正则）
//! created by tynan 2026-09-16

use std::collections::HashMap;

use serde_json::{json, Value as Json};
use tube::{error, Value};

use chrono::Datelike;
use deck::sqlite::{DataRow, Helper};
use deck::Connector;

use crate::service::contact::Contact;
use crate::service::plan::Plan;

/// 送礼台账：已确认 gift 记忆按方向分列（送出 / 收到），带联系人名
pub fn ledger() -> tube::Result<Json> {
    let conn = crate::config::relstore_connector();
    let sql = "SELECT m.id, m.contact_id, c.name AS contact_name, m.content, m.occasion, m.direction, \
               COALESCE(NULLIF(m.date,''), substr(m.created_at,1,10)) AS sort_date \
               FROM memories m LEFT JOIN contacts c ON c.id = m.contact_id \
               WHERE m.mem_type='gift' AND m.status='confirmed' AND (m.superseded_by='' OR m.superseded_by IS NULL) \
               ORDER BY sort_date DESC";
    let mut given = Vec::new();
    let mut received = Vec::new();
    let rows = Helper::query(
        sql,
        vec![],
        |r, _: &Option<Vec<deck::Attribute>>| (0..7).map(|i| r.get_string(i)).collect::<Vec<String>>(),
        &conn,
        &None,
    )
    .map_err(|e| error!("查台账失败: {e}"))?;
    for r in &rows {
        let direction = r[5].clone();
        let item = json!({
            "id": r[0], "contactId": r[1], "contactName": r[2], "content": r[3],
            "occasion": r[4], "date": r[6],
            "direction": if direction.is_empty() { json!("user_to_contact") } else { json!(direction) },
        });
        if direction == "contact_to_user" { received.push(item); } else { given.push(item); }
    }
    Ok(json!({ "ok": true, "given": given, "received": received }))
}

/// 回礼待回应：v_gift_reciprocity 视图直读 + 计划状态标记（pending 联系人未收录，不参与）
pub fn reciprocity() -> tube::Result<Json> {
    let conn = crate::config::relstore_connector();
    let sql = "SELECT v.contact_id, v.name, v.last_received FROM v_gift_reciprocity v \
               JOIN contacts c ON c.id = v.contact_id \
               WHERE c.status = 'confirmed' ORDER BY v.last_received DESC";
    let rows = Helper::query(
        sql,
        vec![],
        |r, _: &Option<Vec<deck::Attribute>>| (0..3).map(|i| r.get_string(i)).collect::<Vec<String>>(),
        &conn,
        &None,
    )
    .map_err(|e| error!("查回礼失败: {e}"))?;
    let mut items: Vec<Json> = Vec::new();
    for r in &rows {
        items.push(json!({
            "contactId": r[0], "name": r[1], "date": r[2],
            "hasActivePlan": false, // 下面补
        }));
    }
    for item in items.iter_mut() {
        let contact_id = item["contactId"].as_str().unwrap_or_default().to_owned();
        let n = count_of(
            &conn,
            &format!("SELECT count(*) AS n FROM plans WHERE contact_id='{contact_id}' AND status NOT IN ('sent','done')"),
        )?;
        item["hasActivePlan"] = json!(n > 0);
    }
    Ok(json!({ "ok": true, "items": items }))
}

/// 单值查询（SELECT count(*) 类）
fn count_of(conn: &Connector, sql: &str) -> tube::Result<i64> {
    Helper::query(
        sql,
        vec![],
        |r, _: &Option<Vec<deck::Attribute>>| r.get_string(0).parse::<i64>().unwrap_or(0),
        conn,
        &None,
    )
    .map(|rows| rows.first().copied().unwrap_or(0))
    .map_err(|e| error!("查询失败: {e}"))
}

/// 固定节日表（match 规则与 JSON 版一致：教师节只匹配「老师/教师」标签或名称）
const FIXED_HOLIDAYS: [(&str, &str, &str, fn(&Json) -> bool); 4] = [
    ("teacher_day", "教师节", "09-10", teacher_match),
    ("women_day", "妇女节", "03-08", |_c| false),
    ("new_year", "元旦", "01-01", |_c| false),
    ("christmas", "圣诞节", "12-25", |_c| false),
];

fn teacher_match(c: &Json) -> bool {
    let tags = serde_json::from_str::<Json>(c["tags"].as_str().unwrap_or("[]")).unwrap_or_else(|_| json!([]));
    let tags_hit = tags
        .as_array()
        .map(|a| a.iter().any(|t| t.as_str().map(|s| s.contains("老师") || s.contains("教师")).unwrap_or(false)))
        .unwrap_or(false);
    tags_hit || c["name"].as_str().map(|s| s.contains("老师") || s.contains("教师")).unwrap_or(false)
}

/// 计算今天距离当年/次年 MM-DD 的天数
fn days_until(md: &str, today: &chrono::NaiveDate) -> Option<i64> {
    let month: u32 = md[..2].parse().ok()?;
    let day: u32 = md[3..5].parse().ok()?;
    for year in [today.year(), today.year() + 1] {
        if let Some(next) = chrono::NaiveDate::from_ymd_opt(year, month, day) {
            let diff = (next - *today).num_days();
            if diff >= 0 {
                return Some(diff);
            }
        }
    }
    None
}

/// 生日模糊字段 → (月, 日)（兼容 YYYY-MM-DD / MM-DD / 每年-MM-DD）
fn birthday_md(birthday: &str) -> Option<(u32, u32)> {
    let b = birthday.trim().replace("每年-", "");
    let parts: Vec<&str> = b.split('-').collect();
    match parts.as_slice() {
        [y, m, d] if y.len() == 4 => Some((m.parse().ok()?, d.parse().ok()?)),
        [m, d] if m.len() == 2 => Some((m.parse().ok()?, d.parse().ok()?)),
        _ => None,
    }
}

/// 送礼时机（days 窗口）：生日 + 相关固定节日 + 计划里的具体日期
pub fn occasions(days: i64) -> tube::Result<Json> {
    let conn = crate::config::relstore_connector();
    let today = chrono::Utc::now().date_naive();
    let today_md = format!("{:02}-{:02}", today.month(), today.day());
    let contacts = Contact::new(Value::Null)
        .list(false)?
        .into_iter()
        .filter(|c| c["status"].as_str() != Some("pending")) // 待确认联系人未拍板收录，不参与时机
        .collect::<Vec<Json>>();
    let plans = Plan::new(Value::Null).list()?;
    let mut items: Vec<Json> = Vec::new();

    for c in &contacts {
        let cid = c["id"].as_str().unwrap_or_default().to_owned();
        let name = c["name"].as_str().unwrap_or_default().to_owned();
        // ① 生日（每年）
        let birthday = c["birthday"].as_str().unwrap_or_default().to_owned();
        if let Some((m, d)) = birthday_md(&birthday) {
            if let Some(diff) = days_until(&format!("{m:02}-{d:02}"), &today) {
                if diff <= days {
                    items.push(json!({
                        "contactId": cid, "name": name, "occasion": "birthday", "label": "生日",
                        "date": "", "inDays": diff, "source": "birthday",
                    }));
                }
            }
        }
        // ② 相关固定节日
        for (occasion, label, md, matcher) in FIXED_HOLIDAYS.iter() {
            if !matcher(c) {
                continue;
            }
            if let Some(diff) = days_until(md, &today) {
                if diff <= days {
                    let year = if *md > today_md.as_str() { today.year() } else { today.year() + 1 };
                    items.push(json!({
                        "contactId": cid, "name": name, "occasion": occasion, "label": label,
                        "date": format!("{year}-{md}"), "inDays": diff, "source": "holiday",
                    }));
                }
            }
        }
        // ③ 计划里的具体日期（未送且有日期）
        for p in &plans {
            if p["contactId"].as_str() != Some(cid.as_str()) || matches!(p["status"].as_str(), Some("sent" | "done")) {
                continue;
            }
            let od = p["occasionDate"].as_str().unwrap_or_default().to_owned();
            if od.is_empty() {
                continue;
            }
            if let Ok(date) = chrono::NaiveDate::parse_from_str(&od, "%Y-%m-%d") {
                let diff = (date - today).num_days();
                if diff >= 0 && diff <= days {
                    let occasion = p["occasion"].as_str().unwrap_or_default().to_owned();
                    items.push(json!({
                        "contactId": cid, "name": name,
                        "occasion": occasion, "label": if occasion.is_empty() { json!("自定义") } else { json!(occasion) },
                        "date": od, "inDays": diff, "source": "plan",
                        "planId": p["id"], "idea": p["idea"], "status": p["status"],
                    }));
                }
            }
        }
    }
    items.sort_by_key(|i| i["inDays"].as_i64().unwrap_or(i64::MAX));
    items.truncate(12);
    Ok(json!({ "ok": true, "occasions": items }))
}

/// 疏远预警：每联系人最近一条已确认记忆距今天数，超过窗口的列出。
/// 取代过的记忆不算；「每年-MM-DD」这类循环日期不是互动事件，解析失败直接跳过（与 JSON 实现口径一致）。
pub fn fading(days: i64) -> tube::Result<Json> {
    let conn = crate::config::relstore_connector();
    let today = chrono::Utc::now().date_naive();
    let sql = "SELECT m.contact_id, c.name, c.relation, \
               COALESCE(NULLIF(m.date,''), substr(m.created_at,1,10)) AS last_day \
               FROM memories m JOIN contacts c ON c.id = m.contact_id \
               WHERE m.status='confirmed' AND (m.superseded_by='' OR m.superseded_by IS NULL) \
                 AND c.archived=0 AND c.status!='pending' AND m.contact_id!=''";
    let rows = Helper::query(
        sql,
        vec![],
        |r, _: &Option<Vec<deck::Attribute>>| (0..4).map(|i| r.get_string(i)).collect::<Vec<String>>(),
        &conn,
        &None,
    )
    .map_err(|e| error!("查疏远预警失败: {e}"))?;
    // 每联系人取最近一条可解析日期；不在 SQL 里 MAX 是为了避免非法日期串按字典序压过合法日期
    let mut best: HashMap<String, (String, String, chrono::NaiveDate)> = HashMap::new();
    for r in &rows {
        let raw = r[3].as_str();
        let parsed = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .or_else(|_| chrono::NaiveDate::parse_from_str(raw.get(..10).unwrap_or(""), "%Y-%m-%d"));
        let Ok(d) = parsed else { continue };
        match best.get(&r[0]) {
            Some((_, _, prev)) if *prev >= d => {}
            _ => {
                best.insert(r[0].clone(), (r[1].clone(), r[2].clone(), d));
            }
        }
    }
    let mut items: Vec<Json> = best
        .into_iter()
        .filter_map(|(cid, (name, relation, d))| {
            let gap = (today - d).num_days();
            if gap < days {
                return None;
            }
            Some(json!({
                "contactId": cid, "name": name, "relation": relation,
                "lastDate": d.format("%Y-%m-%d").to_string(), "days": gap,
            }))
        })
        .collect();
    items.sort_by(|a, b| b["days"].as_i64().unwrap_or(0).cmp(&a["days"].as_i64().unwrap_or(0)));
    Ok(json!({ "ok": true, "fading": items }))
}
