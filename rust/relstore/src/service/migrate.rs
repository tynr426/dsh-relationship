//! relstore — 旧 JSON 一次性迁移
//! contacts/memories/materials/plans 四文件 → SQLite，并把源文件改名备份（家法对齐 dbvault/migrate.rs）
//! created by tynan 2026-09-16

use serde_json::{json, Value as Json};
use tube::{error, Value};

use crate::service::{contact::Contact, material::Material, memory::Memory, plan::Plan};

/// 执行迁移；force=false 且库里已有联系人时拒绝
pub fn run(dir: &str, force: bool) -> tube::Result<()> {
    let contacts_service = Contact::new(Value::Null);
    let existing = contacts_service.list(true)?.len();
    if existing > 0 && !force {
        return Err(error!("库已有 {existing} 个联系人；确认覆盖导入请加 --force。"));
    }

    // 读四个 JSON 文件（plans 允许缺失——v4 时代数据没有计划）
    let read = |name: &str| -> tube::Result<Json> {
        let path = format!("{dir}/{name}");
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| error!("解析 {path} 失败: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!([])),
            Err(e) => Err(error!("读 {path} 失败: {e}")),
        }
    };
    let contacts = read("contacts.json")?.as_array().cloned().unwrap_or_default();
    let memories = read("memories.json")?.as_array().cloned().unwrap_or_default();
    let materials = read("materials.json")?.as_array().cloned().unwrap_or_default();
    let plans = read("plans.json")?.as_array().cloned().unwrap_or_default();

    // 素材先于记忆导入（memories.source_id 指向素材；plan sent 的 memory 已在 plans.memoryId 里描述，重导不重建）
    for mt in &materials {
        Material::new(Value::from(mt.clone())).add()?;
    }
    for c in &contacts {
        Contact::new(Value::from(c.clone())).add()?;
    }
    for m in &memories {
        Memory::new(Value::from(m.clone())).add()?;
    }
    for p in &plans {
        Plan::new(Value::from(p.clone())).add()?;
    }

    // 源文件改名备份
    let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
    for name in ["contacts.json", "memories.json", "materials.json", "plans.json"] {
        let p = std::path::PathBuf::from(dir).join(name);
        if p.exists() {
            let mut target = p.clone().into_os_string();
            target.push(format!(".imported-{stamp}"));
            std::fs::rename(&p, &target).map_err(|e| error!("备份 {} 失败: {e}", p.display()))?;
        }
    }

    println!(
        "{}",
        json!({
            "ok": true,
            "migrated": { "contacts": contacts.len(), "memories": memories.len(), "materials": materials.len(), "plans": plans.len() },
            "backupSuffix": format!(".imported-{stamp}"),
        })
    );
    Ok(())
}
