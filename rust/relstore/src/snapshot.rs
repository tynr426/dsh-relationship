// 快照不执行初始化或导入的 SQL；恢复仅在事务中写回白名单表。
use std::{collections::BTreeMap, fs, os::unix::fs::{OpenOptionsExt, PermissionsExt}, path::Path};
use clap::Subcommand;
use deck::{sqlite::Helper, Connector};
use serde_json::{json, Value as Json};
use tube::{error, Result, Value};

#[derive(Subcommand)]
pub enum Command {
    Create {
        #[arg(long)] output: String,
        #[arg(long, default_value_t = false)] json: bool,
    },
    Validate {
        #[arg(long, default_value_t = false)] json: bool,
    },
    Restore {
        #[arg(long)] input: String,
        #[arg(long)] expected: String,
        #[arg(long, default_value_t = false)] json: bool,
    },
}

fn uri(file: &Path, mode: &str) -> Result<String> {
    let absolute = fs::canonicalize(file).map_err(|_| error!("snapshot path unavailable"))?;
    let escaped = absolute.to_string_lossy().replace('%', "%25").replace('?', "%3F").replace('#', "%23");
    Ok(format!("file:{escaped}?mode={mode}"))
}

fn connector(file: &Path) -> Result<Connector> {
    let meta = fs::symlink_metadata(file).map_err(|_| error!("snapshot file unavailable"))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 64 * 1024 * 1024 {
        return Err(error!("invalid snapshot file"));
    }
    Ok(Connector::new("sqlite").db(&uri(file, "ro")?))
}

// 保留 SQL 字面量，并容许旧库通过 ALTER 追加列后产生的列顺序差异。
fn canonical(sql: &str) -> String {
    let mut out = String::new();
    let mut literal = false;
    for ch in sql.chars() {
        if ch == '\'' { literal = !literal; out.push(ch); }
        else if literal { out.push(ch); }
        else if !ch.is_ascii_whitespace() && ch != '"' { out.push(ch.to_ascii_lowercase()); }
    }
    out = out.replace("createviewifnotexists", "createview");
    if out.starts_with("createtable") {
        if let Some(start) = out.find('(') {
            let mut parts = Vec::new();
            let mut depth = 0;
            let mut quoted = false;
            let mut at = start + 1;
            let mut end = None;
            for (i, ch) in out.char_indices().skip_while(|(i, _)| *i <= start) {
                if ch == '\'' { quoted = !quoted; }
                if quoted { continue; }
                match ch {
                    '(' => depth += 1,
                    ')' if depth > 0 => depth -= 1,
                    ',' if depth == 0 => { parts.push(out[at..i].to_owned()); at = i + 1; }
                    ')' if depth == 0 => { parts.push(out[at..i].to_owned()); end = Some(i); break; }
                    _ => {}
                }
            }
            parts.sort();
            let Some(end) = end else { return out };
            return format!("{}({}{}", &out[..start], parts.join(","), &out[end..]);
        }
    }
    out
}

fn allowed_schema() -> Vec<String> {
    include_str!("../resource/sql/initialize.sql").split(';').filter_map(|stmt| {
        let sql = stmt.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n");
        let sql = sql.trim();
        sql.starts_with("CREATE ").then(|| canonical(sql))
    }).collect()
}

fn scalar(conn: &Connector, sql: &str) -> Result<i64> {
    let rows = Helper::query(sql, vec![], |r, _| r.get::<_, i64>(0).unwrap_or(-1), conn, &None)?;
    rows.first().copied().ok_or_else(|| error!("invalid snapshot result"))
}

pub fn validate(file: &Path) -> Result<Json> {
    let conn = connector(file)?;
    let rows = Helper::query("SELECT type,name,sql FROM sqlite_master", vec![],
        |r, _| (r.get::<_, String>(0).unwrap_or_default(), r.get::<_, String>(1).unwrap_or_default(), r.get::<_, Option<String>>(2).unwrap_or(None)), &conn, &None)?;
    let expected = allowed_schema();
    let mut found = Vec::new();
    for (kind, name, sql) in rows {
        if kind == "index" && sql.is_none() && ["contacts", "memories", "materials", "plans", "relation_types"].iter()
            .any(|table| name == format!("sqlite_autoindex_{table}_1")) { continue; }
        let Some(sql) = sql else { return Err(error!("unapproved snapshot schema")) };
        let normalized = canonical(&sql);
        if !["table", "index", "view"].contains(&kind.as_str()) || !expected.contains(&normalized) {
            return Err(error!("unapproved snapshot schema"));
        }
        found.push(normalized);
    }
    found.sort();
    let mut expected = expected;
    expected.sort();
    if found != expected || scalar(&conn, "PRAGMA user_version")? != 0 || scalar(&conn, "PRAGMA application_id")? != 0 {
        return Err(error!("unsupported snapshot schema version"));
    }
    let check = Helper::query("PRAGMA integrity_check", vec![], |r, _| r.get::<_, String>(0).unwrap_or_default(), &conn, &None)?;
    if check != vec!["ok".to_owned()] { return Err(error!("snapshot integrity check failed")); }
    // SQLite affinity permits values of the wrong type; check every declared column.
    for table in ["contacts", "memories", "materials", "plans", "relation_types"] {
        let columns = Helper::query(&format!("PRAGMA table_info('{table}')"), vec![],
            |r, _| (r.get::<_, String>(1).unwrap_or_default(), r.get::<_, String>(2).unwrap_or_default()), &conn, &None)?;
        for (name, kind) in columns {
            let ty = if kind.to_uppercase().starts_with("TEXT") { "text" } else { "integer" };
            if scalar(&conn, &format!("SELECT count(*) FROM \"{table}\" WHERE \"{name}\" IS NOT NULL AND typeof(\"{name}\") != '{ty}'"))? != 0 {
                return Err(error!("invalid snapshot row type"));
            }
        }
    }
    let mut counts = BTreeMap::new();
    for table in ["contacts", "memories", "materials", "plans", "relation_types"] {
        counts.insert(if table == "relation_types" { "relationTypes" } else { table }, scalar(&conn, &format!("SELECT count(*) FROM {table}"))?);
    }
    Ok(json!({"ok": true, "counts": counts}))
}

fn restore(file: &Path, input: &Path, expected: &Path) -> Result<Json> {
    let checked = validate(input)?;
    validate(expected)?;
    validate(file)?;
    let source = connector(input)?;
    let mut statements = vec![
        ("ATTACH DATABASE :input AS restored".to_owned(), vec![("input".into(), Value::from(uri(input, "ro")?))]),
        ("ATTACH DATABASE :expected AS expected".to_owned(), vec![("expected".into(), Value::from(uri(expected, "ro")?))]),
        ("CREATE TEMP TABLE restore_guard (ok INTEGER CONSTRAINT restore_version_guard CHECK(ok = 1))".to_owned(), vec![]),
    ];
    let mut expected_matches = Vec::new();
    let mut restored_matches = Vec::new();
    let mut replacements = Vec::new();
    for table in ["contacts", "memories", "materials", "plans", "relation_types"] {
        let columns = Helper::query(&format!("PRAGMA table_info('{table}')"), vec![],
            |r, _| r.get::<_, String>(1).unwrap_or_default(), &source, &None)?;
        let columns = columns.iter().map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(",");
        for (schema, checks) in [("expected", &mut expected_matches), ("restored", &mut restored_matches)] {
            checks.push(format!("NOT EXISTS (SELECT {columns} FROM main.{table} EXCEPT SELECT {columns} FROM {schema}.{table}) AND NOT EXISTS (SELECT {columns} FROM {schema}.{table} EXCEPT SELECT {columns} FROM main.{table})"));
        }
        replacements.push((format!("DELETE FROM main.{table}"), vec![]));
        replacements.push((format!("INSERT INTO main.{table} ({columns}) SELECT {columns} FROM restored.{table}"), vec![]));
    }
    // 比较和替换同属一个事务；并发写入会冲突，重试恢复则允许主库已是目标版本。
    statements.push((format!("INSERT INTO restore_guard VALUES (({}) OR ({}))", expected_matches.join(" AND "), restored_matches.join(" AND ")), vec![]));
    statements.extend(replacements);
    Helper::executes(statements, &Connector::new("sqlite").db(&uri(file, "rw")?))?;
    Ok(checked)
}

pub fn run(cmd: Command, file: &Path) -> Result<()> {
    match cmd {
        Command::Restore { input, expected, .. } => println!("{}", restore(file, Path::new(&input), Path::new(&expected))?),
        Command::Validate { .. } => println!("{}", validate(file)?),
        Command::Create { output, .. } => {
            // Schema validation precedes VACUUM; readonly source includes committed WAL.
            validate(file)?;
            let output = Path::new(&output);
            let handle = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(output)
                .map_err(|_| error!("snapshot output unavailable"))?;
            drop(handle);
            let conn = connector(file)?;
            let result = (|| {
                Helper::execute("VACUUM INTO :output", vec![("output".into(), Value::from(output.to_string_lossy().to_string()))], &conn)?;
                fs::set_permissions(output, fs::Permissions::from_mode(0o600)).map_err(|_| error!("snapshot permissions failed"))?;
                let checked = validate(output)?;
                fs::File::open(output).and_then(|f| f.sync_all()).map_err(|_| error!("snapshot sync failed"))?;
                Ok(checked)
            })();
            match result {
                Ok(checked) => println!("{checked}"),
                Err(err) => { let _ = fs::remove_file(output); return Err(err); }
            }
        }
    }
    Ok(())
}
