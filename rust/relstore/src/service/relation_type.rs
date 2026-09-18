//! relstore — 关系类型服务：自定义关系类型的增删改（内置 6 类不可删除）
//! 写法对齐 derive.rs 家法：配置类小表直接走 Helper SQL，不派生 Model。
//! 完整性由本层保证：key 格式校验、内置保护、删除前占用检查（家法：FK 关闭，service 层把关）。
//! created by tynan 2026-09-18

use serde_json::{json, Value as Json};
use tube::{error, Value};

use deck::sqlite::{DataRow, Helper};
use deck::Connector;

/// 列顺序固定：key(0) label(1) sort(2) builtin(3) created_at(4) updated_at(5)
const COLS: &str = "\"key\", \"label\", \"sort\", \"builtin\", \"created_at\", \"updated_at\"";

/// 关系类型服务（无状态，全部静态方法）
pub struct RelationType;

fn conn() -> Connector {
    crate::config::relstore_connector()
}

/// NULL 时间戳在 DataRow 层读作字面量 "NULL"，归一为空串
fn norm_ts(v: &str) -> String {
    if v == "NULL" { String::new() } else { v.to_owned() }
}

/// 行 → 契约 JSON（camelCase，builtin 归一为 bool）
fn row_json(r: &[String]) -> Json {
    json!({
        "key": r[0],
        "label": r[1],
        "sort": r[2].parse::<i64>().unwrap_or(100),
        "builtin": r[3].parse::<i64>().unwrap_or(0) != 0,
        "createdAt": norm_ts(&r[4]),
        "updatedAt": norm_ts(&r[5]),
    })
}

/// key 规范：小写字母开头，仅小写字母/数字/下划线，1–32 字
pub fn validate_key(key: &str) -> tube::Result<String> {
    let k = key.trim();
    let ok = !k.is_empty()
        && k.len() <= 32
        && k.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if !ok {
        return Err(error!("key 非法：小写字母开头，仅含小写字母/数字/下划线，不超过 32 字"));
    }
    Ok(k.to_owned())
}

/// 单值查询（SELECT count(*) 类，与 derive.rs 家法一致）
fn count_of(sql: &str, key: &str) -> tube::Result<i64> {
    let rows = Helper::query(
        sql,
        vec![("p1".to_owned(), Value::from(key))],
        |r, _: &Option<Vec<deck::Attribute>>| r.get_string(0).parse::<i64>().unwrap_or(0),
        &conn(),
        &None,
    )?;
    Ok(rows.first().copied().unwrap_or(0))
}

impl RelationType {
    /// 按编号取一行（列元组），不存在返回 None
    fn find(key: &str) -> tube::Result<Option<Vec<String>>> {
        let sql = format!("SELECT {COLS} FROM relation_types WHERE \"key\" = :p1");
        let rows = Helper::query(
            &sql,
            vec![("p1".to_owned(), Value::from(key))],
            |r, _: &Option<Vec<deck::Attribute>>| (0..6).map(|i| r.get_string(i)).collect::<Vec<String>>(),
            &conn(),
            &None,
        )?;
        Ok(rows.into_iter().next())
    }

    /// key 是否已注册（联系人 service 校验 relation 用）
    pub fn exists(key: &str) -> tube::Result<bool> {
        Ok(count_of("SELECT count(*) FROM relation_types WHERE \"key\" = :p1", key)? > 0)
    }

    /// 列出全部类型（sort 升序，同序按 key）
    pub fn list() -> tube::Result<Vec<Json>> {
        let sql = format!("SELECT {COLS} FROM relation_types ORDER BY \"sort\" ASC, \"key\" ASC");
        let rows = Helper::query(
            &sql,
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| (0..6).map(|i| r.get_string(i)).collect::<Vec<String>>(),
            &conn(),
            &None,
        )?;
        Ok(rows.iter().map(|r| row_json(r)).collect())
    }

    /// 新增自定义类型（builtin=0；重复 key 报错）
    pub fn add(key: &str, label: &str, sort: Option<i64>) -> tube::Result<Json> {
        let k = Self::validate(key, label)?;
        if Self::exists(&k)? {
            return Err(error!("关系类型已存在: {k}"));
        }
        let now = crate::model::now();
        Helper::execute(
            "INSERT INTO relation_types (\"key\", \"label\", \"sort\", \"builtin\", \"created_at\", \"updated_at\") \
             VALUES (:p1, :p2, :p3, 0, :p4, :p4)",
            vec![
                ("p1".to_owned(), Value::from(k.as_str())),
                ("p2".to_owned(), Value::from(label)),
                ("p3".to_owned(), Value::from(sort.unwrap_or(100))),
                ("p4".to_owned(), Value::from(now.as_str())),
            ],
            &conn(),
        )?;
        Ok(row_json(&Self::find(&k)?.ok_or_else(|| error!("关系类型写入后回读失败"))?))
    }

    /// 更新显示名/排序（key 不可改；内置类型同样允许改显示名）
    pub fn set(key: &str, label: Option<String>, sort: Option<i64>) -> tube::Result<Json> {
        let k = validate_key(key)?;
        let existing = Self::find(&k)?.ok_or_else(|| error!("关系类型不存在: {k}"))?;
        let new_label = label.map(|l| l.trim().to_owned()).filter(|l| !l.is_empty());
        if let Some(l) = &new_label {
            if l.chars().count() > 40 {
                return Err(error!("显示名不能超过 40 字"));
            }
        }
        if new_label.is_none() && sort.is_none() {
            return Err(error!("未提供要更新的字段"));
        }
        let l = new_label.unwrap_or_else(|| existing[1].clone());
        let s = sort.unwrap_or_else(|| existing[2].parse::<i64>().unwrap_or(100));
        Helper::execute(
            "UPDATE relation_types SET \"label\" = :p2, \"sort\" = :p3, \"updated_at\" = :p4 WHERE \"key\" = :p1",
            vec![
                ("p1".to_owned(), Value::from(k.as_str())),
                ("p2".to_owned(), Value::from(l.as_str())),
                ("p3".to_owned(), Value::from(s)),
                ("p4".to_owned(), Value::from(crate::model::now().as_str())),
            ],
            &conn(),
        )?;
        Ok(row_json(&Self::find(&k)?.ok_or_else(|| error!("关系类型更新后回读失败"))?))
    }

    /// 删除自定义类型：内置拒绝；仍被联系人使用拒绝（家法：不悄悄改数据）
    pub fn remove(key: &str) -> tube::Result<String> {
        let k = validate_key(key)?;
        let existing = Self::find(&k)?.ok_or_else(|| error!("关系类型不存在: {k}"))?;
        if existing[3].parse::<i64>().unwrap_or(0) != 0 {
            return Err(error!("内置类型不可删除: {k}"));
        }
        let n = count_of("SELECT count(*) FROM contacts WHERE \"relation\" = :p1", &k)?;
        if n > 0 {
            return Err(error!("该类型正被 {n} 个联系人使用，请先调整这些联系人的关系再删除"));
        }
        Helper::execute(
            "DELETE FROM relation_types WHERE \"key\" = :p1",
            vec![("p1".to_owned(), Value::from(k.as_str()))],
            &conn(),
        )?;
        Ok(k)
    }

    /// add 通道的组合校验（key 格式 + label 非空/长度）
    fn validate(key: &str, label: &str) -> tube::Result<String> {
        let k = validate_key(key)?;
        let l = label.trim();
        if l.is_empty() {
            return Err(error!("显示名不能为空"));
        }
        if l.chars().count() > 40 {
            return Err(error!("显示名不能超过 40 字"));
        }
        Ok(k)
    }
}