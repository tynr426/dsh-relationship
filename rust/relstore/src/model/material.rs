//! 素材模型
//! created by tynan 2026-09-16

use deck::Model;

/// 原始素材（溯源存档，状态由 v_material_status 视图派生）
#[derive(Model, Default, Debug, Clone)]
#[table(name = "materials", comment = "原始素材", primary = "identity")]
pub struct Material {
    /// 素材编号（mt_xxxx）
    pub id: String,
    /// 类型（text/screenshot/file）
    pub kind: String,
    /// 原文
    pub text: String,
    /// 摘要（前 120 字）
    pub excerpt: String,
    /// 关联联系人
    #[field(rename = "contactId")]
    pub contact_id: String,
    /// 场景标签（记忆提取时继承）
    pub occasion: String,
    /// 存档时间
    #[field(rename = "capturedAt")]
    pub captured_at: String,
}
