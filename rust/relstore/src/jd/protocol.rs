use serde_json::{Value, json};

pub const GATEWAY: &str = "https://api.jd.com/routerjson";
pub const GOODS: &str = "jd.union.open.goods.query";
pub const PROMOTION: &str = "jd.union.open.promotion.common.get";
pub const REQUIRED: [&str; 3] = ["JD_APP_KEY", "JD_APP_SECRET", "JD_SITE_ID"];
pub const RESPONSE_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}

impl Failure {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn output(&self) -> Value {
        json!({"ok": false, "status": self.status, "error": self.message})
    }
}

pub fn protocol_error() -> Failure {
    Failure::new(502, "京东返回的数据格式异常，请稍后重试")
}

/// 可信错误描述：京东固定错误表文案（zh_desc/message），不回显请求内容；
/// 只取限长且无控制字符的第一条，其余字段一律脱敏。
fn trusted_desc(body: &Value) -> Option<String> {
    ["zh_desc", "message", "msg", "errorMessage"]
        .iter()
        .filter_map(|key| body.get(*key))
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|desc| !desc.is_empty() && desc.len() <= 200 && !desc.chars().any(char::is_control))
        .map(str::to_owned)
}

pub fn api_error(body: &Value) -> Failure {
    let code = body
        .get("code")
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        })
        .filter(|code| code.len() <= 32 && code.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or_else(|| "未知".into());
    let hint = trusted_desc(body).unwrap_or_else(|| "请检查应用权限、媒体 ID 和推广位配置".into());
    let hint = if hint.contains("权限") {
        format!("{hint}（请在京东联盟开放平台为应用申请该 API 权限）")
    } else {
        hint
    };
    Failure::new(502, format!("京东接口拒绝请求（代码 {code}）：{hint}"))
}

pub fn code_is(body: &Value, expected: u64) -> bool {
    body.get("code").is_some_and(|code| {
        code.as_u64() == Some(expected) || code.as_str().is_some_and(|s| s == expected.to_string())
    })
}

pub fn decode_result(body: Value, method: &str, key: &str) -> std::result::Result<Value, Failure> {
    if let Some(error) = body.get("error_response") {
        return Err(api_error(error));
    }
    let wrapper_key = format!("{}_responce", method.replace('.', "_"));
    let wrapper = body.get(&wrapper_key).ok_or_else(|| {
        if body.get("code").is_some() {
            api_error(&body)
        } else {
            protocol_error()
        }
    })?;
    if wrapper.get("code").is_some() && !code_is(wrapper, 0) {
        return Err(api_error(wrapper));
    }
    let result = wrapper.get(key).ok_or_else(protocol_error)?;
    let result = match result.as_str() {
        Some(text) => serde_json::from_str(text).map_err(|_| protocol_error())?,
        None => result.clone(),
    };
    if !code_is(&result, 200) {
        return Err(api_error(&result));
    }
    Ok(result)
}
