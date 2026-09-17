//! relstore — 库初始化
//! 库文件缺失（或缺 contacts 表）时逐条执行 resource/sql/initialize.sql，
//! 对新库收紧权限为 0600（unix），并设置 WAL（持久，一次即可）
//! created by tynan 2026-09-16

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use deck::sqlite::{DataRow, Helper};
use deck::{Connector, DatabaseType};
use tube::{err_log, error, Result};

const INITIALIZE_SQL: &str = include_str!("../resource/sql/initialize.sql");

pub struct Initialize;

impl Initialize {
    /// 系统启动初始化检查：确保库文件与表结构就绪
    pub fn initialize(conn: &Connector) -> Result<()> {
        if conn.db_type != DatabaseType::Sqlite {
            return Ok(());
        }
        let db_path = Path::new(&conn.database);
        // 是否为本次新建的库文件 —— 必须在首次打开连接前判断（连接会创建空文件）
        let fresh = !db_path.exists();

        // 确保父目录存在
        if let Some(parent) = db_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| error!("{}", e))?;
            }
        }

        // 表结构是否已存在（查询走 Helper::query，execute 不接受返回行的语句）
        let exists = match Helper::query(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='contacts'",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| r.get_string(0).parse::<u64>().unwrap_or(0),
            conn,
            &None,
        ) {
            Ok(rows) => rows.first().copied().unwrap_or(0) > 0,
            Err(err) => {
                err_log!("检查 relstore 表结构失败 {err}");
                false
            }
        };
        if exists {
            // 老库增量迁移（补列，幂等），再确保 WAL
            Self::migrate_columns(conn)?;
            return Self::ensure_wal(conn);
        }

        err_log!("relstore 库 {} 不存在或缺少表结构，开始初始化", conn.database);
        // deck 的批量执行按参数批次循环同一语句，这里逐条拆分执行建表脚本
        for stmt in INITIALIZE_SQL.split(';') {
            let stmt = stmt.trim();
            if stmt.is_empty() {
                continue;
            }
            // 去掉语句前后的行注释行（注释后跟语句的块不能整块跳过）
            let stmt = stmt
                .lines()
                .filter(|l| !l.trim_start().starts_with("--"))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_owned();
            if stmt.is_empty() {
                continue;
            }
            if let Err(err) = Helper::execute(&stmt, vec![], conn) {
                err_log!("初始化 relstore 失败 {err}");
                // 全新文件失败时清掉半成品，避免留下损坏的库
                if fresh && db_path.exists() {
                    let _ = std::fs::remove_file(db_path);
                }
                return Err(err);
            }
        }

        // WAL（持久）+ 新库收紧权限：仅当前用户可读写
        Self::ensure_wal(conn)?;
        if fresh {
            let _ = std::fs::set_permissions(db_path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// 老库增量迁移：缺列即 ALTER TABLE 补上（幂等，可安全重跑）。
    /// 新增列必须 NOT NULL DEFAULT，与 initialize.sql 里的建表定义保持一致。
    fn migrate_columns(conn: &Connector) -> Result<()> {
        let columns: Vec<String> = Helper::query(
            "PRAGMA table_info('memories')",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| r.get_string(1), // 1 = name
            conn,
            &None,
        )?;
        if !columns.iter().any(|c| c == "source_quote") {
            Helper::execute(
                "ALTER TABLE memories ADD COLUMN \"source_quote\" TEXT(200) NOT NULL DEFAULT ''",
                vec![],
                conn,
            )?;
            err_log!("relstore 增量迁移：memories 补列 source_quote");
        }
        Ok(())
    }

    /// WAL 模式（journal_mode 持久化在库文件里，重复执行无害）
    /// 注意：journal_mode 赋值会返回结果行，必须走 Helper::query（execute 遇返回行即报错）
    fn ensure_wal(conn: &Connector) -> Result<()> {
        if let Err(err) = Helper::query(
            "PRAGMA journal_mode = WAL",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| r.get_string(0),
            conn,
            &None,
        ) {
            err_log!("设置 WAL 失败 {err}");
            return Err(err);
        }
        Ok(())
    }
}
