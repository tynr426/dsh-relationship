//! relstore — 库初始化
//! 库文件缺失（或缺 contacts 表）时逐条执行 resource/sql/initialize.sql，
//! 对新库收紧权限为 0600（unix），并设置 WAL（持久，一次即可）
//! created by tynan 2026-09-16

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use deck::sqlite::{DataRow, Helper};
use deck::{Connector, DatabaseType};
use tube::{err_log, error, Result, Value};

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
        let table_columns = |table: &str| -> Result<Vec<String>> {
            Ok(Helper::query(
                &format!("PRAGMA table_info('{table}')"),
                vec![],
                |r, _: &Option<Vec<deck::Attribute>>| r.get_string(1), // 1 = name
                conn,
                &None,
            )?)
        };
        let memory_columns = table_columns("memories")?;
        if !memory_columns.iter().any(|c| c == "source_quote") {
            Helper::execute(
                "ALTER TABLE memories ADD COLUMN \"source_quote\" TEXT(200) NOT NULL DEFAULT ''",
                vec![],
                conn,
            )?;
            err_log!("relstore 增量迁移：memories 补列 source_quote");
        }
        let contact_columns = table_columns("contacts")?;
        if !contact_columns.iter().any(|c| c == "status") {
            Helper::execute(
                "ALTER TABLE contacts ADD COLUMN \"status\" TEXT(12) NOT NULL DEFAULT 'confirmed' CHECK (\"status\" IN ('pending','confirmed'))",
                vec![],
                conn,
            )?;
            err_log!("relstore 增量迁移：contacts 补列 status");
        }
        Self::ensure_relation_types(conn)?;
        Self::relax_relation_check(conn)?;
        Self::relax_plan_status_check(conn)?;
        Ok(())
    }

    /// plans 旧 CHECK 扩充 done：保留原建表定义、全部字段、索引/触发器和视图。
    /// 不改历史状态；整个重建使用 Helper::executes 的单连接事务，重复初始化无操作。
    fn relax_plan_status_check(conn: &Connector) -> Result<()> {
        // DataRow::get_string 会把单引号加倍转义，不可用于读取并重放 DDL。
        let schemas = Helper::query(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='plans'",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| r.get::<_, String>(0).unwrap_or_default(),
            conn, &None,
        )?;
        let Some(original) = schemas.first() else { return Ok(()) };
        // 兼容空白、大小写及列名引号差异，只修改已知旧约束，其他 SQL 原样保留。
        let compact = |s: &str| -> String {
            s.chars().filter(|c| !c.is_ascii_whitespace() && !['"', '`', '[', ']'].contains(c))
                .collect::<String>().to_ascii_lowercase()
        };
        let insertion = original.match_indices("'sent'").find_map(|(at, token)| {
            let end = at + token.len();
            (compact(&original[..at]).ends_with("check(statusin('idea','decided',")
                && compact(&original[end..]).starts_with("))")).then_some(end)
        });
        let Some(at) = insertion else { return Ok(()) };
        let mut create_sql = original.clone();
        create_sql.insert_str(at, ",'done'");
        let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let columns = Helper::query(
            "PRAGMA table_info('plans')", vec![],
            |r, _: &Option<Vec<deck::Attribute>>| r.get::<_, String>(1).unwrap_or_default(), conn, &None,
        )?.iter().map(|c| quote(c)).collect::<Vec<_>>().join(",");
        // 一并暂存所有视图，避免间接引用 plans 的视图在 RENAME 时失效或被重写。
        let views = Helper::query(
            "SELECT name, sql FROM sqlite_master WHERE type='view'", vec![],
            |r, _: &Option<Vec<deck::Attribute>>| (r.get::<_, String>(0).unwrap_or_default(), r.get::<_, String>(1).unwrap_or_default()), conn, &None,
        )?;
        let objects = Helper::query(
            "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND \
             ((type='index' AND tbl_name='plans') OR type='trigger')",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| (r.get::<_, String>(0).unwrap_or_default(), r.get::<_, String>(1).unwrap_or_default(), r.get::<_, String>(2).unwrap_or_default()),
            conn, &None,
        )?;
        let mut script: Vec<(String, Vec<(String, Value)>)> = Vec::new();
        // 其他表上的触发器也可能引用 plans，先暂存移除，避免 RENAME 重写其引用。
        for (kind, name, _) in &objects {
            if kind == "trigger" {
                script.push((format!("DROP TRIGGER {}", quote(name)), vec![]));
            }
        }
        for (name, _) in &views {
            script.push((format!("DROP VIEW {}", quote(name)), vec![]));
        }
        script.push(("ALTER TABLE plans RENAME TO plans_rebuild_legacy".to_owned(), vec![]));
        script.push((create_sql, vec![]));
        script.push((format!("INSERT INTO plans ({columns}) SELECT {columns} FROM plans_rebuild_legacy"), vec![]));
        script.push(("DROP TABLE plans_rebuild_legacy".to_owned(), vec![]));
        for (_, sql) in views {
            script.push((sql, vec![]));
        }
        for (_, _, sql) in objects {
            script.push((sql, vec![]));
        }
        Helper::executes(script, conn)?;
        err_log!("relstore 增量迁移：plans CHECK 支持 done");
        Ok(())
    }

    /// 老库补建 relation_types 注册表（幂等）：缺表即建并播种 6 个内置类型。
    fn ensure_relation_types(conn: &Connector) -> Result<()> {
        let exists = Helper::query(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='relation_types'",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| r.get_string(0).parse::<u64>().unwrap_or(0),
            conn,
            &None,
        )?;
        if exists.first().copied().unwrap_or(0) > 0 {
            return Ok(());
        }
        for stmt in [
            "CREATE TABLE \"relation_types\" (\
               \"key\" TEXT(32) NOT NULL, \"label\" TEXT(64) NOT NULL, \
               \"sort\" INTEGER NOT NULL DEFAULT 100, \"builtin\" INTEGER NOT NULL DEFAULT 0, \
               \"created_at\" TEXT(64), \"updated_at\" TEXT(64), \
               PRIMARY KEY (\"key\"), CHECK (\"builtin\" IN (0,1)))",
            "INSERT INTO \"relation_types\" (\"key\", \"label\", \"sort\", \"builtin\") VALUES \
               ('family','家人',1,1),('friend','朋友',2,1),('colleague','同事',3,1),\
               ('client','客户',4,1),('partner','伙伴',5,1),('other','其他',6,1)",
        ] {
            Helper::execute(stmt, vec![], conn)?;
        }
        err_log!("relstore 增量迁移：新建 relation_types 并播种内置类型");
        Ok(())
    }

    /// 老库 contacts 表带着写死的 relation CHECK 约束，会挡住自定义类型写入；
    /// SQLite 无法删约束，重建表（幂等：以建表 SQL 是否仍含 relation IN 检查为准）。
    /// 重建走「建新表 → 拷数据 → DROP 旧表 → RENAME 回原名」：不用 RENAME 离场，
    /// 是因为 PRAGMA 是连接级设置而 deck 存在连接池，PRAGMA+RENAME 会把
    /// 视图（v_gift_reciprocity）里的表引用一起改掉；DROP 被视图引用的表是
    /// 允许的（视图短暂悬空，RENAME 回原名后自然恢复）。
    fn relax_relation_check(conn: &Connector) -> Result<()> {
        let sql = Helper::query(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| r.get_string(0),
            conn,
            &None,
        )?;
        let Some(create_sql) = sql.first() else { return Ok(()) };
        // 兼容列名带引号/不带引号的建表 SQL：CHECK (relation IN (...) 变体统一按小写匹配
        if !create_sql.to_lowercase().contains("relation in (") {
            return Ok(());
        }
        err_log!("relstore 增量迁移：contacts 重建以放宽 relation CHECK 约束");
        // 全程不允许任何时刻存在悬空视图：schema 解析（任何 DDL 的 prepare）碰到
        // 引用缺失表的视图都会报 no such table。因此先把引用 contacts 的视图
        // DROP 掉，RENAME 离场（无视图引用时不会触发引用重写），最后按原 SQL 重建。
        // 全部语句走 Helper::executes 单连接事务（家法）。
        let view_sql = Helper::query(
            "SELECT name, sql FROM sqlite_master WHERE type='view' AND instr(lower(sql), 'contacts') > 0",
            vec![],
            |r, _: &Option<Vec<deck::Attribute>>| (r.get_string(0), r.get_string(1)),
            conn,
            &None,
        )?;
        let mut script: Vec<(String, Vec<(String, Value)>)> = Vec::new();
        let mut views_to_restore: Vec<String> = Vec::new();
        for (name, sql) in &view_sql {
            script.push((format!("DROP VIEW IF EXISTS \"{name}\""), vec![]));
            views_to_restore.push(sql.clone());
        }
        script.push(("ALTER TABLE contacts RENAME TO contacts_rebuild_legacy".to_owned(), vec![]));
        script.push(("CREATE TABLE \"contacts\" (\
            \"id\" TEXT(40) NOT NULL, \"name\" TEXT(80) NOT NULL, \
            \"relation\" TEXT(32) NOT NULL DEFAULT 'other', \"tags\" TEXT(512) DEFAULT '[]', \
            \"birthday\" TEXT(16) DEFAULT '', \"notes\" TEXT(2048) DEFAULT '', \
            \"archived\" INTEGER NOT NULL DEFAULT 0, \"status\" TEXT(12) NOT NULL DEFAULT 'confirmed', \
            \"created_at\" TEXT(64), \"updated_at\" TEXT(64), \
            PRIMARY KEY (\"id\"), CHECK (\"archived\" IN (0,1)), CHECK (\"status\" IN ('pending','confirmed')))"
            .to_owned(), vec![]));
        script.push(("INSERT INTO \"contacts\" (\"id\",\"name\",\"relation\",\"tags\",\"birthday\",\"notes\",\"archived\",\"status\",\"created_at\",\"updated_at\") \
            SELECT \"id\",\"name\",\"relation\",\"tags\",\"birthday\",\"notes\",\"archived\",\
              COALESCE(NULLIF(\"status\",''),'confirmed'),\"created_at\",\"updated_at\" \
            FROM \"contacts_rebuild_legacy\"".to_owned(), vec![]));
        script.push(("DROP TABLE contacts_rebuild_legacy".to_owned(), vec![]));
        for sql in &views_to_restore {
            script.push((sql.clone(), vec![])); // 按原建视图 SQL 重建
        }
        Helper::executes(script, conn)?;
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
