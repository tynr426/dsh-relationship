//! 联系人模型
//! created by tynan 2026-09-16

use deck::Model;

/// 联系人
/// 说明：id 为代码生成的文本主键（c_xxxx），不标注 primary ——
/// deck 的 insert preparator 会跳过 primary 字段，导致编号写不进去（dbvault 家法同款注释）
#[derive(Model, Default, Debug, Clone)]
#[table(name = "contacts", comment = "联系人", primary = "identity")]
pub struct Contact {
    /// 联系人编号
    pub id: String,
    /// 称呼
    pub name: String,
    /// 关系（family/friend/colleague/client/partner/other）
    pub relation: String,
    /// 标签（JSON 数组文本）
    pub tags: String,
    /// 生日（模糊日期：MM-DD / YYYY-MM-DD / 每年-MM-DD）
    pub birthday: String,
    /// 备注
    pub notes: String,
    /// 是否归档（0/1）
    pub archived: i64,
    /// 创建时间
    #[field(rename = "createdAt")]
    pub created_at: String,
    /// 更新时间
    #[field(rename = "updatedAt")]
    pub updated_at: String,
}
