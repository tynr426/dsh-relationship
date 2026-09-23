use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

use chrono::{FixedOffset, Utc};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde_json::{Value, json};

use super::config::Config;
use super::items::{Item, parse_items, validate_item_id, valid_jd_url};
use super::protocol::{Failure, GATEWAY, GOODS, PROMOTION, RESPONSE_LIMIT, decode_result};

pub fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut text = secret.to_owned();
    for (key, value) in params {
        if key != "sign" {
            text.push_str(key);
            text.push_str(value);
        }
    }
    text.push_str(secret);
    tube::crypto::get_md5(&text).to_uppercase()
}

pub struct JdClient {
    config: Config,
    client: Client,
    pub endpoint: String,
}

impl JdClient {
    pub fn new(config: Config) -> std::result::Result<Self, Failure> {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .redirect(Policy::none())
            .build()
            .map_err(|_| Failure::new(503, "京东 HTTPS 客户端初始化失败"))?;
        Ok(Self {
            config,
            client,
            endpoint: GATEWAY.to_owned(),
        })
    }

    pub fn request(&self, method: &str, payload: Value, result_key: &str) -> std::result::Result<Value, Failure> {
        let timestamp = Utc::now()
            .with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        let mut params: BTreeMap<String, String> = [
            ("method", method.to_owned()),
            ("app_key", self.config.app_key.clone()),
            ("timestamp", timestamp),
            ("v", "1.0".to_owned()),
            ("format", "json".to_owned()),
            ("sign_method", "md5".to_owned()),
            ("360buy_param_json", payload.to_string()),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
        params.insert("sign".into(), sign(&params, &self.config.app_secret));
        let response = self
            .client
            .post(&self.endpoint)
            .form(&params)
            .send()
            .map_err(|e| {
                Failure::new(
                    if e.is_timeout() { 504 } else { 502 },
                    "京东请求失败或超时，请稍后重试",
                )
            })?;
        if !response.status().is_success() {
            return Err(Failure::new(
                502,
                format!("京东网关请求失败（HTTP {}）", response.status().as_u16()),
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(RESPONSE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::new(502, "京东响应读取失败，请稍后重试"))?;
        if bytes.len() as u64 > RESPONSE_LIMIT {
            return Err(Failure::new(502, "京东响应过大，请缩小搜索范围"));
        }
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::new(502, "京东返回的数据格式异常，请稍后重试"))?;
        decode_result(body, method, result_key)
    }

    pub fn goods(&self, query: Value) -> std::result::Result<Vec<Item>, Failure> {
        let result = self.request(GOODS, json!({"goodsReq": query}), "queryResult")?;
        parse_items(&result)
    }

    pub fn search(&self, query: Value) -> std::result::Result<Value, Failure> {
        let items: Vec<_> = self.goods(query)?.iter().map(Item::output).collect();
        Ok(json!({"ok": true, "items": items}))
    }

    pub fn promote(&self, item_id: &str) -> std::result::Result<Value, Failure> {
        validate_item_id(item_id)?;
        let item = self
            .goods(json!({"eliteId": 1, "itemIds": [item_id]}))?
            .into_iter()
            .find(|item| item.item_id == item_id)
            .ok_or_else(|| Failure::new(404, "商品已不可推广或已下架，请重新搜索"))?;
        let mut request =
            json!({"sceneId": 1, "materialId": item.item_id, "siteId": self.config.site_id});
        if let Some(position_id) = self.config.position_id {
            request["positionId"] = json!(position_id);
        }
        let result = self.request(PROMOTION, json!({"promotionCodeReq": request}), "getResult")?;
        let link = result
            .pointer("/data/clickURL")
            .and_then(Value::as_str)
            .filter(|link| link.len() <= 4096 && valid_jd_url(link, false))
            .ok_or_else(|| Failure::new(502, "京东未返回有效推广链接，请检查媒体 ID 和推广权限"))?;
        Ok(json!({
            "productName": item.name,
            "productPrice": format!("¥{:.2}（京东参考价）", item.price),
            "productUrl": link,
        }))
    }
}
