//! relstore — 数据模型：联系人 / 记忆 / 素材 / 礼物计划
//! 结构体经 deck Model 派生生成类信息（列名 / 别名），字段与 resource/sql/initialize.sql 一一对应；
//! 库内列名 snake_case，payload/输出键 camelCase（与工作台 REST 契约一致）
//! created by tynan 2026-09-16

pub mod contact;
pub mod material;
pub mod memory;
pub mod plan;

pub use contact::Contact;
pub use material::Material;
pub use memory::Memory;
pub use plan::Plan;

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;

/// 当前时间（RFC3339，落库为 TEXT）
pub fn now() -> String {
    Utc::now().to_rfc3339()
}

/// 当天日期（YYYY-MM-DD）
pub fn today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

static SEQ: AtomicU32 = AtomicU32::new(0);

/// 生成形如 c_1a2b3c4d 的短 id（prefix + '_' + 8 位 hex），
/// 与 JSON 版 uid(prefix) 格式一致；时间纳秒 + pid + 进程内序号混合，单人本地应用无碰撞担忧
pub fn uid(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let seq = SEQ.fetch_add(1, Ordering::Relaxed) as u64;
    let mixed = nanos ^ (pid << 32) ^ (seq << 16) ^ (std::process::id() as u64).rotate_left(8);
    format!("{}_{:08x}", prefix, (mixed & 0xffff_ffff) as u32)
}

/// 逗号/中文逗号分隔列表 → JSON 数组文本；已是数组文本则原样保留（tags 通用）
pub fn parse_list(v: &str) -> String {
    let trimmed = v.trim();
    if trimmed.starts_with('[') {
        return trimmed.to_owned();
    }
    let list: Vec<serde_json::Value> = trimmed
        .split(|c| c == ',' || c == '，' || c == ' ')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(serde_json::Value::from)
        .collect();
    serde_json::Value::Array(list).to_string()
}

/// 场景标签归一化：trim → 小写 → 空白转下划线 → 截断 40（与 JSON 版 normalizeOccasion 一致）
pub fn normalize_occasion(v: &str) -> String {
    v.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join("_").chars().take(40).collect()
}
