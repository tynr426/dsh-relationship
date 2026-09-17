//! relstore — 数据源配置
//! 库文件路径解析（默认 ~/.dsh/dsh-relationship/rel.db，可被 RELSTORE_DB / --db 覆盖）
//! 与 deck Connector 的注册（写法对齐 dsh-qa/rust/dbvault 的 DATASOURCE_KEY 模式）
//! created by tynan 2026-09-16

use std::path::PathBuf;

use deck::Connector;

/// 数据源 key，对齐 dbvault 家法
pub const DATASOURCE_KEY: &str = "relstore";

/// 词法规范化路径（折叠 . 与 ..，不要求文件存在）
fn normalize(path: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 默认库路径：~/.dsh/dsh-relationship/rel.db（可用环境变量 RELSTORE_DB 或 --db 覆盖）
pub fn default_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("RELSTORE_DB") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_owned());
    normalize(
        PathBuf::from(home)
            .join(".dsh")
            .join("dsh-relationship")
            .join("rel.db"),
    )
}

/// 解析最终使用的库路径（--db 优先级最高）
pub fn resolve_db_path(explicit: Option<&str>) -> PathBuf {
    match explicit {
        Some(p) => PathBuf::from(p),
        None => default_db_path(),
    }
}

/// 构造并注册库连接器，返回连接器实例
pub fn register_connector(db_path: &PathBuf) -> Connector {
    let path = db_path.to_string_lossy().to_string();
    let mut conn = Connector::new("sqlite").db(&path);
    // 家法同款：sqlite 开启参数化，避免 TableService 插入路径的参数混绑问题
    conn.parameterize = true;
    deck::set_connector(DATASOURCE_KEY, conn.clone());
    conn
}

/// 取已注册的库连接器（migrate 等底层操作使用）
pub fn relstore_connector() -> Connector {
    deck::get_connector(DATASOURCE_KEY, "Sqlite").expect("relstore 数据源未注册")
}
