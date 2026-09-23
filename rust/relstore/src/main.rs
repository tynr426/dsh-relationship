//! relstore — 关系记忆工作台存储层（SQLite 单文件，0600）CLI。
//!
//! 设计约定（家法对齐 dsh-qa/rust/dbvault）：
//! - 唯一写入方：本工具。Node 侧（dsh-relationship 工作台）只通过 spawn 本 CLI 读写，绝不直接开库。
//! - 数据访问：统一走 deck kit 的 DataTable + TableService 模式；完整性靠 service 层
//!   （FK 关闭是家法，级联用 Helper::executes 单连接事务）。
//! - 输出约定：所有命令支持 --json 供机器解析；人读模式面向手工排障。
//! created by tynan 2026-09-16

use clap::{Parser, Subcommand};
use serde_json::{json, Value as Json};

use tube::{error, Value};

// error!/conds!/cols! 等宏展开引用 crate::Error / crate::Condition —— 在 crate 根重导出（dbvault 家法）
#[allow(unused_imports)]
pub(crate) use deck::{ColumnExpr, Condition, Joint, Operator, OrderExpr};
pub(crate) use tube::Error;

#[macro_use]
extern crate deck;
#[macro_use]
extern crate tube;

mod config;
mod initialize;
mod jd;
mod model;
mod service;

use config::resolve_db_path;
use initialize::Initialize;
use service::{contact::Contact, derive, material::Material, memory::Memory, migrate, plan::Plan, relation_type::RelationType};

/// CLI 入口：解析参数 → 注册连接器 → 初始化库 → 分发命令
fn main() {
    let cli = Cli::parse();
    if let Cmd::Jd { cmd } = cli.cmd {
        jd::run(cmd);
        return;
    }
    let db_path = resolve_db_path(cli.db.as_deref());
    let conn = config::register_connector(&db_path);
    if let Err(err) = Initialize::initialize(&conn) {
        eprintln!("✗ {err}");
        std::process::exit(1);
    }
    if let Err(err) = run(cli.cmd) {
        eprintln!("✗ {err}");
        std::process::exit(1);
    }
}

/// 命令分发：把 CLI 参数组装为服务负载，业务逻辑全部在 service 层
fn run(cmd: Cmd) -> tube::Result<()> {
    match cmd {
        Cmd::Migrate { dir, force, .. } => migrate::run(&dir, force),
        Cmd::Contact { cmd } => run_contact(cmd),
        Cmd::Memory { cmd } => run_memory(cmd),
        Cmd::Material { cmd } => run_material(cmd),
        Cmd::Plan { cmd } => run_plan(cmd),
        Cmd::RelationType { cmd } => run_relation_type(cmd),
        Cmd::Jd { .. } => unreachable!(),
        Cmd::Ledger { json } => {
            let data = derive::ledger()?;
            emit_or_print(json, "✅ 台账已生成", data);
            Ok(())
        }
        Cmd::Reciprocity { json } => {
            let data = derive::reciprocity()?;
            emit_or_print(json, "✅ 回礼待回应已生成", data);
            Ok(())
        }
        Cmd::Occasion { days, json } => {
            let data = derive::occasions(days)?;
            emit_or_print(json, "✅ 时机已生成", data);
            Ok(())
        }
        Cmd::Fading { days, json } => {
            let data = derive::fading(days)?;
            emit_or_print(json, "✅ 疏远预警已生成", data);
            Ok(())
        }
    }
}

fn run_contact(cmd: ContactCmd) -> tube::Result<()> {
    match cmd {
        ContactCmd::List { archived, json } => {
            let data = Contact::new(Value::Null).list(archived)?;
            emit_or_print(json, &format!("共 {} 个联系人", data.len()), json!({ "ok": true, "contacts": data }));
            Ok(())
        }
        ContactCmd::Add { name, relation, tags, birthday, notes, status, json } => {
            let payload = json!({
                "name": name, "relation": relation, "tags": tags, "birthday": birthday, "notes": notes,
                "status": status,
            });
            let c = Contact::new(Value::from(payload)).add()?;
            emit_or_print(json, &format!("✅ 已建档 {}", c["id"].as_str().unwrap_or("")), json!({ "ok": true, "contact": c }));
            Ok(())
        }
        ContactCmd::Set { id, name, relation, tags, birthday, notes, archived, status, json } => {
            let mut payload = serde_json::Map::new();
            payload.insert("id".into(), json!(id));
            for (k, v) in [("name", name), ("relation", relation), ("tags", tags), ("birthday", birthday), ("notes", notes)] {
                if let Some(v) = v {
                    payload.insert(k.into(), json!(v));
                }
            }
            if let Some(v) = archived {
                payload.insert("archived".into(), json!(v));
            }
            if let Some(v) = status {
                payload.insert("status".into(), json!(v));
            }
            let c = Contact::new(Value::from(Json::Object(payload))).set()?;
            emit_or_print(json, "✅ 已更新联系人", json!({ "ok": true, "contact": c }));
            Ok(())
        }
        ContactCmd::Remove { id, json } => {
            let (cid, name, n) = Contact::new(Value::Null).remove(&id)?;
            emit_or_print(
                json,
                &format!("✅ 已删除 {cid}（{name}），连带 {n} 条记忆"),
                json!({ "ok": true, "removed": { "id": cid, "name": name, "removedMemories": n } }),
            );
            Ok(())
        }
    }
}

fn run_memory(cmd: MemoryCmd) -> tube::Result<()> {
    match cmd {
        MemoryCmd::List { contact, status, type_, direction, occasion, lifespan, q, json } => {
            let payload = json!({
                "contactId": contact, "status": status, "type": type_,
                "direction": direction, "occasion": occasion, "lifespan": lifespan, "q": q,
            });
            let data = Memory::new(Value::from(payload)).list()?;
            emit_or_print(json, &format!("共 {} 条记忆", data.len()), json!({ "ok": true, "memories": data }));
            Ok(())
        }
        MemoryCmd::Add { contact, type_, content, date, said_at, direction, lifespan, occasion, importance, source_id, source_quote, author, json } => {
            let payload = json!({
                "contactId": contact, "type": type_, "content": content, "date": date,
                "saidAt": said_at, "direction": direction, "lifespan": lifespan,
                "occasion": occasion, "importance": importance, "sourceId": source_id,
                "sourceQuote": source_quote, "author": author,
            });
            let m = Memory::new(Value::from(payload)).add()?;
            emit_or_print(json, "✅ 记忆已登记", json!({ "ok": true, "memory": m }));
            Ok(())
        }
        MemoryCmd::Set { id, content, type_, date, said_at, direction, lifespan, occasion, importance, status, reason, json } => {
            let mut payload = serde_json::Map::new();
            payload.insert("id".into(), json!(id));
            for (k, v) in [("content", content), ("type", type_), ("date", date), ("saidAt", said_at), ("direction", direction), ("lifespan", lifespan), ("occasion", occasion)] {
                if let Some(v) = v {
                    payload.insert(k.into(), json!(v));
                }
            }
            if let Some(v) = importance {
                payload.insert("importance".into(), json!(v));
            }
            if let Some(v) = status {
                payload.insert("status".into(), json!(v));
            }
            if let Some(v) = reason {
                payload.insert("reason".into(), json!(v));
            }
            let m = Memory::new(Value::from(Json::Object(payload))).set()?;
            emit_or_print(json, "✅ 已更新记忆", json!({ "ok": true, "memory": m }));
            Ok(())
        }
        MemoryCmd::Confirm { ids, json } => {
            let list: Vec<String> = ids.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect();
            let data = Memory::confirm(&list)?;
            emit_or_print(json, &format!("✅ 已确认 {} 条", data.len()), json!({ "ok": true, "confirmed": data }));
            Ok(())
        }
        MemoryCmd::Reject { id, reason, json } => {
            let m = Memory::reject(&id, &reason)?;
            emit_or_print(json, "✅ 已驳回", json!({ "ok": true, "memory": m }));
            Ok(())
        }
        MemoryCmd::Restore { id, json } => {
            let m = Memory::restore(&id)?;
            emit_or_print(json, "✅ 已恢复为待确认", json!({ "ok": true, "memory": m }));
            Ok(())
        }
        MemoryCmd::Supersede { id, by, json } => {
            let m = Memory::supersede(&id, &by)?;
            emit_or_print(json, "✅ 已标记被取代", json!({ "ok": true, "memory": m }));
            Ok(())
        }
        MemoryCmd::Remove { id, json } => {
            Memory::remove(&id)?;
            emit_or_print(json, "✅ 已删除记忆", json!({ "ok": true }));
            Ok(())
        }
    }
}

fn run_material(cmd: MaterialCmd) -> tube::Result<()> {
    match cmd {
        MaterialCmd::List { status, json } => {
            let payload = json!({ "status": status });
            let data = Material::new(Value::from(payload)).list()?;
            emit_or_print(json, &format!("共 {} 段素材", data.len()), json!({ "ok": true, "materials": data }));
            Ok(())
        }
        MaterialCmd::Add { text, contact, occasion, kind, json } => {
            let payload = json!({ "text": text, "contactId": contact, "occasion": occasion, "kind": kind });
            let m = Material::new(Value::from(payload)).add()?;
            emit_or_print(json, &format!("✅ 素材已存档 {}", m["id"].as_str().unwrap_or("")), json!({ "ok": true, "material": m }));
            Ok(())
        }
        MaterialCmd::Show { id, json } => {
            let m = Material::new(Value::Null).one(&id)?;
            emit_or_print(json, "✅ 素材详情", json!({ "ok": true, "material": m }));
            Ok(())
        }
        MaterialCmd::Link { id, memory, json } => {
            let m = Material::link(&id, &memory)?;
            emit_or_print(json, "✅ 已关联记忆", json!({ "ok": true, "material": m }));
            Ok(())
        }
        MaterialCmd::Remove { id, json } => {
            Material::remove(&id)?;
            emit_or_print(json, "✅ 已删除素材", json!({ "ok": true }));
            Ok(())
        }
    }
}

fn run_plan(cmd: PlanCmd) -> tube::Result<()> {
    match cmd {
        PlanCmd::List { contact, status, json } => {
            let payload = json!({ "contactId": contact, "status": status });
            let data = Plan::new(Value::from(payload)).list()?;
            emit_or_print(json, &format!("共 {} 个计划", data.len()), json!({ "ok": true, "plans": data }));
            Ok(())
        }
        PlanCmd::Add { contact, idea, occasion, date, budget, product_name, product_price, product_url, source, status, json } => {
            let payload = json!({
                "contactId": contact, "idea": idea, "occasion": occasion, "occasionDate": date,
                "budget": budget, "productName": product_name, "productPrice": product_price,
                "productUrl": product_url, "source": source,
            });
            let payload = match status {
                Some(st) => { let mut p = payload; p["status"] = json!(st); p }
                None => payload,
            };
            let p = Plan::new(Value::from(payload)).add()?;
            emit_or_print(json, &format!("✅ 计划已创建 {}", p["id"].as_str().unwrap_or("")), json!({ "ok": true, "plan": p }));
            Ok(())
        }
        PlanCmd::Set { id, idea, occasion, date, budget, product_name, product_price, product_url, status, json } => {
            let mut payload = serde_json::Map::new();
            payload.insert("id".into(), json!(id));
            for (k, v) in [("idea", idea), ("occasion", occasion), ("occasionDate", date), ("budget", budget), ("productName", product_name), ("productPrice", product_price), ("productUrl", product_url), ("status", status)] {
                if let Some(v) = v {
                    payload.insert(k.into(), json!(v));
                }
            }
            let p = Plan::new(Value::from(Json::Object(payload))).set()?;
            emit_or_print(json, "✅ 已更新计划", json!({ "ok": true, "plan": p }));
            Ok(())
        }
        PlanCmd::Sent { id, json } => {
            let data = Plan::new(Value::Null).mark_sent(&id)?;
            emit_or_print(json, "✅ 已入台账，礼物记忆已生成", data);
            Ok(())
        }
        PlanCmd::Remove { id, json } => {
            Plan::remove(&id)?;
            emit_or_print(json, "✅ 已删除计划", json!({ "ok": true }));
            Ok(())
        }
    }
}

fn emit_or_print(is_json: bool, human: &str, payload: Json) {
    if is_json {
        println!("{payload}");
    } else {
        println!("{human}");
    }
}

// ---------- CLI 定义 ----------

#[derive(Parser)]
#[command(name = "relstore", version, about = "关系记忆工作台存储层（SQLite，0600）")]
struct Cli {
    /// 库文件路径（默认 ~/.dsh/dsh-relationship/rel.db，可用 RELSTORE_DB 覆盖）
    #[arg(long, global = true)]
    db: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    Jd {
        #[command(subcommand)]
        cmd: jd::Command,
    },
    /// 从旧 JSON 四文件一次性迁移入 SQLite，并把源文件改名备份
    Migrate {
        /// JSON 文件所在目录（contacts/memories/materials/plans .json）
        #[arg(long)]
        dir: String,
        /// 目标库已有联系人时仍强制导入
        #[arg(long, default_value_t = false)]
        force: bool,
        /// 迁移结果恒为 JSON，此开关仅为兼容统一调用习惯
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 联系人管理
    Contact {
        #[command(subcommand)]
        cmd: ContactCmd,
    },
    /// 关系记忆管理
    Memory {
        #[command(subcommand)]
        cmd: MemoryCmd,
    },
    /// 素材存档管理
    Material {
        #[command(subcommand)]
        cmd: MaterialCmd,
    },
    /// 礼物计划管理
    Plan {
        #[command(subcommand)]
        cmd: PlanCmd,
    },
    /// 送礼台账（送出/收到两列）
    Ledger {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 回礼待回应（v_gift_reciprocity 视图）
    Reciprocity {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 送礼时机（生日 + 相关节日 + 计划日期，默认 30 天窗）
    Occasion {
        #[arg(long, default_value_t = 30)]
        days: i64,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 疏远预警（距最近一条已确认记忆超过 N 天的联系人，默认 90 天）
    Fading {
        #[arg(long, default_value_t = 90)]
        days: i64,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 关系类型管理（内置 6 类不可删除）
    RelationType {
        #[command(subcommand)]
        cmd: RelationTypeCmd,
    },
}

fn run_relation_type(cmd: RelationTypeCmd) -> tube::Result<()> {
    match cmd {
        RelationTypeCmd::List { json } => {
            let data = RelationType::list()?;
            emit_or_print(json, &format!("共 {} 个关系类型", data.len()), json!({ "ok": true, "relationTypes": data }));
            Ok(())
        }
        RelationTypeCmd::Add { key, label, sort, json } => {
            let t = RelationType::add(&key, &label, sort)?;
            emit_or_print(json, &format!("✅ 已新增关系类型 {}", t["key"].as_str().unwrap_or("")), json!({ "ok": true, "relationType": t }));
            Ok(())
        }
        RelationTypeCmd::Set { key, label, sort, json } => {
            let t = RelationType::set(&key, label, sort)?;
            emit_or_print(json, &format!("✅ 已更新关系类型 {}", t["key"].as_str().unwrap_or("")), json!({ "ok": true, "relationType": t }));
            Ok(())
        }
        RelationTypeCmd::Remove { key, json } => {
            let removed = RelationType::remove(&key)?;
            emit_or_print(json, &format!("✅ 已删除关系类型 {removed}"), json!({ "ok": true, "removed": removed }));
            Ok(())
        }
    }
}

#[derive(Subcommand)]
enum RelationTypeCmd {
    /// 列出关系类型（sort 升序）
    List {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 新增自定义关系类型
    Add {
        #[arg(long, help = "小写字母开头，仅含小写字母/数字/下划线，≤32 字")]
        key: String,
        #[arg(long, help = "显示名（≤40 字）")]
        label: String,
        #[arg(long)]
        sort: Option<i64>,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 更新显示名/排序（key 不可改）
    Set {
        key: String,
        #[arg(long)]
        label: Option<String>,
        #[arg(long)]
        sort: Option<i64>,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 删除自定义类型（内置拒绝；仍被联系人使用拒绝）
    Remove {
        key: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ContactCmd {
    /// 列出联系人（默认不含归档；待确认（pending）联系人同样列出，是否纳入由调用方决定）
    List {
        #[arg(long, default_value_t = false)]
        archived: bool,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 新增联系人（--status pending 进待确认队列，默认 confirmed）
    Add {
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "other")]
        relation: String,
        #[arg(long, default_value = "", help = "逗号/空格分隔，如 \"大学同学 羽毛球\"")]
        tags: String,
        #[arg(long, default_value = "")]
        birthday: String,
        #[arg(long, default_value = "")]
        notes: String,
        #[arg(long, default_value = "confirmed")]
        status: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 更新联系人（只覆盖传入字段）
    Set {
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        relation: Option<String>,
        #[arg(long)]
        tags: Option<String>,
        #[arg(long)]
        birthday: Option<String>,
        #[arg(long)]
        notes: Option<String>,
        #[arg(long)]
        archived: Option<bool>,
        #[arg(long, help = "收录状态 pending/confirmed（拍板转正走这里）")]
        status: Option<String>,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 删除联系人（记忆/素材/计划 单事务级联）
    Remove {
        id: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum MemoryCmd {
    /// 列出记忆（多过滤参数）
    List {
        #[arg(long, default_value = "")]
        contact: String,
        #[arg(long, default_value = "")]
        status: String,
        #[arg(long, default_value = "")]
        type_: String,
        #[arg(long, alias = "dir", default_value = "")]
        direction: String,
        #[arg(long, default_value = "")]
        occasion: String,
        #[arg(long, default_value = "")]
        lifespan: String,
        #[arg(long, default_value = "")]
        q: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 新增记忆（author=user 即确认，author=ai 进待确认）
    Add {
        #[arg(long)]
        contact: String,
        #[arg(long)]
        type_: String,
        #[arg(long)]
        content: String,
        #[arg(long, default_value = "")]
        date: String,
        #[arg(long, alias = "saidAt", default_value = "")]
        said_at: String,
        #[arg(long, alias = "dir", default_value = "")]
        direction: String,
        #[arg(long, default_value = "long")]
        lifespan: String,
        #[arg(long, default_value = "")]
        occasion: String,
        #[arg(long, default_value_t = 2)]
        importance: i64,
        #[arg(long, alias = "sourceId", default_value = "")]
        source_id: String,
        #[arg(long, alias = "sourceQuote", default_value = "")]
        source_quote: String,
        #[arg(long, default_value = "ai")]
        author: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 更新记忆（只覆盖传入字段；--status 变更状态，确认带编辑一步完成）
    Set {
        id: String,
        #[arg(long)]
        content: Option<String>,
        #[arg(long)]
        type_: Option<String>,
        #[arg(long)]
        date: Option<String>,
        #[arg(long, alias = "saidAt")]
        said_at: Option<String>,
        #[arg(long, alias = "dir")]
        direction: Option<String>,
        #[arg(long)]
        lifespan: Option<String>,
        #[arg(long)]
        occasion: Option<String>,
        #[arg(long)]
        importance: Option<i64>,
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 批量确认（逗号分隔编号）
    Confirm {
        #[arg(long)]
        ids: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 驳回
    Reject {
        id: String,
        #[arg(long, alias = "reason", default_value = "")]
        reason: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 恢复（rejected → pending，清驳回原因）
    Restore {
        id: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 标记被取代（supersededBy 指向保留的记忆）
    Supersede {
        id: String,
        #[arg(long)]
        by: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 删除单条
    Remove {
        id: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum MaterialCmd {
    /// 列出素材（--status raw|processed 走派生视图）
    List {
        #[arg(long, default_value = "")]
        status: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 存档素材
    Add {
        #[arg(long)]
        text: String,
        #[arg(long, default_value = "")]
        contact: String,
        #[arg(long, default_value = "")]
        occasion: String,
        #[arg(long, default_value = "text")]
        kind: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 素材详情（带派生状态）
    Show {
        id: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 关联记忆（回写记忆 sourceId）
    Link {
        id: String,
        #[arg(long)]
        memory: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 删除素材（已拆出的记忆不受影响）
    Remove {
        id: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum PlanCmd {
    /// 列出计划
    List {
        #[arg(long, default_value = "")]
        contact: String,
        #[arg(long, default_value = "")]
        status: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 新增计划
    Add {
        #[arg(long)]
        contact: String,
        #[arg(long)]
        idea: String,
        #[arg(long, default_value = "")]
        occasion: String,
        #[arg(long, alias = "date", default_value = "")]
        date: String,
        #[arg(long, default_value = "")]
        budget: String,
        #[arg(long, alias = "product-name", default_value = "")]
        product_name: String,
        #[arg(long, alias = "product-price", default_value = "")]
        product_price: String,
        #[arg(long, alias = "product-url", default_value = "")]
        product_url: String,
        #[arg(long, default_value = "user")]
        source: String,
        #[arg(long)]
        status: Option<String>,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 更新计划（--status idea|decided|sent|done；done 不生成记忆，终态不可重开）
    Set {
        id: String,
        #[arg(long)]
        idea: Option<String>,
        #[arg(long)]
        occasion: Option<String>,
        #[arg(long, alias = "date")]
        date: Option<String>,
        #[arg(long)]
        budget: Option<String>,
        #[arg(long, alias = "product-name")]
        product_name: Option<String>,
        #[arg(long, alias = "product-price")]
        product_price: Option<String>,
        #[arg(long, alias = "product-url")]
        product_url: Option<String>,
        #[arg(long)]
        status: Option<String>,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 标记已送（事务内自动生成 gift 记忆；幂等）
    Sent {
        id: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// 删除计划（关联记忆保留）
    Remove {
        id: String,
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}
