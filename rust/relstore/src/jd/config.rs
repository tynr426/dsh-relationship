use std::collections::BTreeMap;

use super::protocol::Failure;

pub struct Config {
    pub app_key: String,
    pub app_secret: String,
    pub site_id: String,
    pub position_id: Option<u64>,
}

impl Config {
    pub fn parse(env: &BTreeMap<&str, String>) -> std::result::Result<Self, Failure> {
        let required = |key| {
            env.get(key)
                .filter(|value| !value.is_empty())
                .cloned()
                .ok_or_else(|| Failure::new(503, format!("京东联盟未配置：请在本机设置 {key}")))
        };
        let app_key = required("JD_APP_KEY")?;
        let app_secret = required("JD_APP_SECRET")?;
        let site_id = required("JD_SITE_ID")?;
        if !site_id.bytes().all(|b| b.is_ascii_digit())
            || site_id.len() > 32
            || site_id.bytes().all(|b| b == b'0')
        {
            return Err(Failure::new(
                503,
                "JD_SITE_ID 须为有效的网站、APP 或流量媒体 ID（数字），不能使用导购媒体 ID",
            ));
        }
        let position_id = env
            .get("JD_POSITION_ID")
            .filter(|v| !v.is_empty())
            .map(|v| {
                v.parse::<u64>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| Failure::new(503, "JD_POSITION_ID 须为正整数推广位 ID"))
            })
            .transpose()?;
        Ok(Self {
            app_key,
            app_secret,
            site_id,
            position_id,
        })
    }
}
