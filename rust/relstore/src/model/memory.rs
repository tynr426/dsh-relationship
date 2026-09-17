//! 记忆模型（核心表）
//! created by tynan 2026-09-16

use deck::Model;

/// 关系记忆
#[derive(Model, Default, Debug, Clone)]
#[table(name = "memories", comment = "关系记忆", primary = "identity")]
pub struct Memory {
    /// 记忆编号（m_xxxx）
    pub id: String,
    /// 所属联系人
    #[field(rename = "contactId")]
    pub contact_id: String,
    /// 类型（preference/dislike/taboo/event/gift/promise/interaction/attribute）
    /// 注意：库列名 mem_type（type 是 SQL 常用字面量，deck 以字段名作列名无法用 r#），
    /// JSON 契约键仍为 type（rename 别名：插入按 alias 匹配、输出按 alias 输出）
    #[field(rename = "type")]
    pub mem_type: String,
    /// 内容（一句事实）
    pub content: String,
    /// 事实时间（模糊日期）
    pub date: String,
    /// 话语时间（YYYY-MM-DD HH:mm）
    #[field(rename = "saidAt")]
    pub said_at: String,
    /// 重要度（1-3，禁忌与重大事件=3）
    pub importance: i64,
    /// 表达方向（''/user_to_contact/contact_to_user/both）
    pub direction: String,
    /// 记忆寿命（long/short）
    pub lifespan: String,
    /// 场景标签（小写下划线）
    pub occasion: String,
    /// 溯源素材编号（mt_xxxx）
    #[field(rename = "sourceId")]
    pub source_id: String,
    /// 素材原话摘录（提取闸门溯源，逐字出自素材原文）
    #[field(rename = "sourceQuote")]
    pub source_quote: String,
    /// 作者（user/ai）
    pub author: String,
    /// 状态（pending/confirmed/rejected）
    pub status: String,
    /// 驳回原因
    pub reason: String,
    /// 被哪条记忆取代（supersededBy）
    #[field(rename = "supersededBy")]
    pub superseded_by: String,
    /// 确认时间
    #[field(rename = "confirmedAt")]
    pub confirmed_at: String,
    /// 创建时间
    #[field(rename = "createdAt")]
    pub created_at: String,
    /// 更新时间
    #[field(rename = "updatedAt")]
    pub updated_at: String,
}
