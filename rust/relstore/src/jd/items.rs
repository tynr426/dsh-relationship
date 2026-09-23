use reqwest::Url;
use serde_json::{Value, json};

use super::protocol::Failure;

#[derive(Debug)]
pub struct Item {
    pub item_id: String,
    pub name: String,
    pub price: f64,
    pub image_url: String,
}

impl Item {
    pub fn output(&self) -> Value {
        json!({"itemId": self.item_id, "name": self.name, "price": self.price, "imageUrl": self.image_url})
    }
}

pub fn validate_item_id(item_id: &str) -> std::result::Result<(), Failure> {
    if item_id.is_empty()
        || item_id.len() > 256
        || item_id.starts_with("--")
        || !item_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_=+".contains(&b))
    {
        return Err(Failure::new(400, "联盟商品 ID 无效，请重新搜索并选择商品"));
    }
    Ok(())
}

pub fn valid_jd_url(link: &str, image: bool) -> bool {
    if link.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Ok(url) = Url::parse(link) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let scheme_ok = if image {
        url.scheme() == "https"
    } else {
        ["http", "https"].contains(&url.scheme())
    };
    scheme_ok
        && url.host_str().is_some_and(|host| {
            host == "jd.com"
                || host.ends_with(".jd.com")
                || (image && (host == "360buyimg.com" || host.ends_with(".360buyimg.com")))
        })
}

pub fn parse_items(result: &Value) -> std::result::Result<Vec<Item>, Failure> {
    let Some(data) = result.get("data").filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let rows = if let Some(rows) = data.as_array() {
        rows.iter().collect::<Vec<_>>()
    } else if let Some(rows) = data.get("goodsList").and_then(|v| v.as_array()) {
        rows.iter().collect()
    } else if let Some(rows) = data.get("result").and_then(|v| v.as_array()) {
        rows.iter().collect()
    } else if let Some(rows) = data.get("goodsResp") {
        if let Some(array) = rows.as_array() {
            array.iter().collect()
        } else if rows.is_object() {
            vec![rows]
        } else {
            return Err(super::protocol::protocol_error());
        }
    } else if data.is_object() && data.get("itemId").is_some() {
        vec![data]
    } else {
        return Err(super::protocol::protocol_error());
    };
    let mut items = Vec::new();
    for row in rows.into_iter().take(20) {
        let Some(id) = row
            .get("itemId")
            .and_then(Value::as_str)
            .filter(|id| validate_item_id(id).is_ok())
        else {
            continue;
        };
        let Some(name) = row
            .get("skuName")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
        else {
            continue;
        };
        let price = row
            .pointer("/priceInfo/price")
            .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse::<f64>().ok()));
        let Some(price) = price.filter(|price| price.is_finite() && *price > 0.0) else {
            continue;
        };
        let image = row
            .pointer("/imageInfo/imageList/0/url")
            .or_else(|| row.pointer("/imageInfo/imageList/image/url"))
            .and_then(Value::as_str)
            .filter(|url| valid_jd_url(url, true))
            .unwrap_or("");
        if items.iter().any(|item: &Item| item.item_id == id) {
            continue;
        }
        items.push(Item {
            item_id: id.to_owned(),
            name: name.chars().take(100).collect(),
            price,
            image_url: image.to_owned(),
        });
    }
    Ok(items)
}
