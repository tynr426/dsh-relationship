//! relstore — 服务层
//! 写法对齐 dbvault：每个业务对象实现 DataTable + TableService，
//! 数据访问统一走 deck 的 select/insert/update/delete 语句构造器；
//! 完整性靠 service 层（dbvault 家法：FK 关闭，级联用 Helper::executes 单连接事务）
//! created by tynan 2026-09-16

pub mod contact;
pub mod derive;
pub mod material;
pub mod memory;
pub mod migrate;
pub mod plan;
