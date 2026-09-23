//! 礼物计划模型
//! created by tynan 2026-09-16

use deck::Model;

/// 礼物计划（低风险意图，不进确认队列；标已送时由 service 层事务内自动落 gift 记忆）
#[derive(Model, Default, Debug, Clone)]
#[table(name = "plans", comment = "礼物计划", primary = "identity")]
pub struct Plan {
    /// 计划编号（gp_xxxx）
    pub id: String,
    /// 送给谁
    #[field(rename = "contactId")]
    pub contact_id: String,
    /// 场景标签
    pub occasion: String,
    /// 这一次的具体日期（YYYY-MM-DD）
    #[field(rename = "occasionDate")]
    pub occasion_date: String,
    /// 方案名与一句话理由（≤200 字）
    pub idea: String,
    /// 预算
    pub budget: String,
    /// 真实商品：名称
    #[field(rename = "productName")]
    pub product_name: String,
    /// 真实商品：价格
    #[field(rename = "productPrice")]
    pub product_price: String,
    /// 真实商品：链接
    #[field(rename = "productUrl")]
    pub product_url: String,
    /// 状态（idea/decided/sent/done）；done 为普通完成，不生成记忆
    pub status: String,
    /// 标已送时间
    #[field(rename = "sentAt")]
    pub sent_at: String,
    /// 标已送后自动生成的 gift 记忆编号
    #[field(rename = "memoryId")]
    pub memory_id: String,
    /// 来源（user/ai）
    pub source: String,
    /// 创建时间
    #[field(rename = "createdAt")]
    pub created_at: String,
    /// 更新时间
    #[field(rename = "updatedAt")]
    pub updated_at: String,
}
