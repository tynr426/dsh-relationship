use std::collections::BTreeMap;

use clap::Subcommand;
use serde_json::{Value, json};

mod client;
mod config;
mod items;
mod protocol;

use client::JdClient;
use config::Config;
use items::validate_item_id;
use protocol::{Failure, REQUIRED};

#[derive(Subcommand)]
pub enum Command {
    Status {
        #[arg(long)]
        json: bool,
    },
    Search {
        #[arg(long)]
        keyword: String,
        #[arg(long)]
        min_price: Option<f64>,
        #[arg(long)]
        max_price: Option<f64>,
        #[arg(long)]
        json: bool,
    },
    Promote {
        #[arg(long)]
        item_id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        price: Option<f64>,
        #[arg(long)]
        json: bool,
    },
}

type Result<T> = std::result::Result<T, Failure>;

pub fn run(command: Command) {
    match execute(command) {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!("{}", error.output());
            std::process::exit(1);
        }
    }
}

fn execute(command: Command) -> Result<Value> {
    let env: BTreeMap<_, _> = REQUIRED
        .into_iter()
        .chain(["JD_POSITION_ID"])
        .map(|key| {
            (
                key,
                std::env::var(key).unwrap_or_default().trim().to_owned(),
            )
        })
        .collect();
    let missing: Vec<_> = REQUIRED
        .into_iter()
        .filter(|key| env[*key].is_empty())
        .collect();
    if let Command::Status { .. } = command {
        if missing.is_empty() {
            Config::parse(&env)?;
        }
        return Ok(json!({"ok": true, "configured": missing.is_empty(), "missing": missing}));
    }
    match command {
        Command::Search {
            keyword,
            min_price,
            max_price,
            ..
        } => {
            let query = search_query(&keyword, min_price, max_price)?;
            let client = JdClient::new(Config::parse(&env)?)?;
            client.search(query)
        }
        Command::Promote {
            item_id,
            name,
            price,
            ..
        } => {
            validate_item_id(&item_id)?;
            let fallback = promote_fallback(name.as_deref(), price)?;
            let client = JdClient::new(Config::parse(&env)?)?;
            Ok(json!({"ok": true, "product": client.promote(&item_id, fallback)?}))
        }
        Command::Status { .. } => unreachable!(),
    }
}

#[derive(Debug, PartialEq)]
enum SearchQuery {
    Keyword(Value),
    Ranking(Value),
}

/// 降级资料：账号无 goods.query 权限时，promote 用页面已展示的名称/价格替代售前复核。
/// 名称与价格须成对提供，缺失其一视为未提供降级资料。
fn promote_fallback(name: Option<&str>, price: Option<f64>) -> Result<Option<(&str, f64)>> {
    match (name, price) {
        (None, None) => Ok(None),
        (Some(name), Some(price)) => {
            if name.trim().is_empty()
                || name.chars().count() > 200
                || name.chars().any(char::is_control)
            {
                return Err(Failure::new(400, "商品名称须为 1–200 字且不含控制字符"));
            }
            if !price.is_finite() || price <= 0.0 || price > 1_000_000.0 {
                return Err(Failure::new(400, "商品价格须为大于 0 且不超过 1000000 的数字"));
            }
            Ok(Some((name, price)))
        }
        _ => Err(Failure::new(400, "降级选品需同时提供商品名称与价格")),
    }
}

fn search_query(
    keyword: &str,
    min_price: Option<f64>,
    max_price: Option<f64>,
) -> Result<SearchQuery> {
    let keyword = keyword.trim();
    if keyword.encode_utf16().count() > 80 || keyword.chars().any(char::is_control) {
        return Err(Failure::new(
            400,
            "商品关键词最多 80 个字符，留空查看热销榜",
        ));
    }
    for price in [min_price, max_price].into_iter().flatten() {
        if !price.is_finite() || !(0.0..=1_000_000.0).contains(&price) {
            return Err(Failure::new(400, "价格须为 0–1000000 之间的数字"));
        }
    }
    if min_price.zip(max_price).is_some_and(|(min, max)| min > max) {
        return Err(Failure::new(400, "最低价不能大于最高价"));
    }
    if keyword.is_empty() {
        if min_price.is_some() || max_price.is_some() {
            return Err(Failure::new(
                400,
                "热销榜不支持价格筛选，请填写关键词后筛选价格",
            ));
        }
        return Ok(SearchQuery::Ranking(
            json!({"rankId": 200000, "sortType": 3, "pageIndex": 1, "pageSize": 20}),
        ));
    }
    let mut query = json!({"sceneId": 1, "keyword": keyword, "pageIndex": 1, "pageSize": 20});
    if let Some(price) = min_price {
        query["pricefrom"] = json!(price);
    }
    if let Some(price) = max_price {
        query["priceto"] = json!(price);
    }
    Ok(SearchQuery::Keyword(query))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use reqwest::Url;
    use serde_json::{Value, json};

    use client::{JdClient, sign};
    use config::Config;
    use items::{parse_items, parse_rank_items};
    use protocol::{GOODS, PROMOTION, RANKING, decode_result};

    fn config() -> Config {
        Config {
            app_key: "test-key".into(),
            app_secret: "test-secret".into(),
            site_id: "1234".into(),
            position_id: Some(5678),
        }
    }

    fn goods() -> Value {
        json!({"itemId": "union_item-1", "skuName": "岩茶礼盒", "priceInfo": {"price": 99.9},
            "imageInfo": {"imageList": [{"url": "https://img14.360buyimg.com/test.jpg"}]}})
    }

    fn envelope(method: &str, key: &str, data: Value) -> String {
        json!({format!("{}_responce", method.replace('.', "_")): {key: json!({"code": 200, "data": data}).to_string()}}).to_string()
    }

    fn mock(responses: Vec<(u16, String)>) -> (String, JoinHandle<Vec<BTreeMap<String, String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/routerjson", listener.local_addr().unwrap());
        let thread = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let (header_end, length) = loop {
                    let mut buffer = [0u8; 4096];
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..index]).to_lowercase();
                        assert!(headers.starts_with("post /routerjson "));
                        assert!(headers.contains("application/x-www-form-urlencoded"));
                        let length = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse::<usize>()
                            .unwrap();
                        break (index + 4, length);
                    }
                };
                while bytes.len() < header_end + length {
                    let mut buffer = [0u8; 4096];
                    let n = socket.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                }
                let form =
                    String::from_utf8(bytes[header_end..header_end + length].to_vec()).unwrap();
                let url = Url::parse(&format!("http://localhost/?{form}")).unwrap();
                requests.push(url.query_pairs().into_owned().collect());
                write!(socket, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (url, thread)
    }

    #[test]
    fn signs_utf8_original_values_in_sorted_order() {
        let mut params = BTreeMap::from([
            ("app_key".to_owned(), "demo-key".to_owned()),
            ("method".into(), GOODS.into()),
            ("timestamp".into(), "2026-09-20 12:00:00".into()),
            ("v".into(), "1.0".into()),
            ("format".into(), "json".into()),
            ("sign_method".into(), "md5".into()),
            (
                "360buy_param_json".into(),
                "{\"goodsReqDTO\":{\"keyword\":\"岩茶\",\"sceneId\":1}}".into(),
            ),
        ]);
        assert_eq!(
            sign(&params, "demo-secret"),
            "ADD1D49671F47A0C464A74A9CDC40007"
        );
        params.insert("sign".into(), "old-signature".into());
        assert_eq!(
            sign(&params, "demo-secret"),
            "ADD1D49671F47A0C464A74A9CDC40007"
        );
    }

    #[test]
    fn validates_config_without_exposing_values() {
        let mut env = BTreeMap::new();
        assert_eq!(Config::parse(&env).err().unwrap().status, 503);
        env.insert("JD_APP_KEY", "private-key".into());
        env.insert("JD_APP_SECRET", "private-secret".into());
        env.insert("JD_SITE_ID", "private-invalid-site".into());
        let error = Config::parse(&env).err().unwrap().output().to_string();
        assert!(!error.contains("private"));
        env.insert("JD_SITE_ID", "1234".into());
        env.insert("JD_POSITION_ID", "0".into());
        assert!(Config::parse(&env).is_err());
        env.insert("JD_POSITION_ID", "9876".into());
        assert_eq!(Config::parse(&env).unwrap().position_id, Some(9876));
        env.remove("JD_POSITION_ID");
        assert!(Config::parse(&env).unwrap().position_id.is_none());
    }

    #[test]
    fn bounds_query_and_does_not_send_relationship_context() {
        let query = search_query(" 岩茶 ", Some(10.5), Some(200.0)).unwrap();
        assert_eq!(
            query,
            SearchQuery::Keyword(
                json!({"sceneId": 1, "keyword": "岩茶", "pricefrom": 10.5, "priceto": 200.0, "pageIndex": 1, "pageSize": 20})
            )
        );
        for keyword in [&"茶".repeat(81), "茶\u{0001}"] {
            assert_eq!(search_query(keyword, None, None).unwrap_err().status, 400);
        }
        for value in [-1.0, f64::NAN, f64::INFINITY, 1_000_001.0] {
            assert!(search_query("茶", Some(value), None).is_err());
        }
        assert!(search_query("茶", Some(200.0), Some(100.0)).is_err());
        assert!(validate_item_id("https://arbitrary.invalid/").is_err());
    }

    #[test]
    fn blank_query_uses_documented_ranking_contract() {
        let ranked = json!({"itemId": "ranked-1", "skuName": "笔记本", "wlprice": "100",
            "imageUrl": "https://img14.360buyimg.com/test.jpg", "purchasePriceInfo": {"purchasePrice": "95"}});
        let (endpoint, server) = mock(vec![
            (
                200,
                envelope(RANKING, "queryResult", json!({"rankGoodsResp": ranked})),
            ),
            (200, envelope(RANKING, "queryResult", json!([ranked]))),
        ]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        for keyword in ["", " \n\t "] {
            let result = client
                .search(search_query(keyword, None, None).unwrap())
                .unwrap();
            assert_eq!(
                result["items"],
                json!([{"itemId": "ranked-1", "name": "笔记本", "price": 100.0,
                "imageUrl": "https://img14.360buyimg.com/test.jpg"}])
            );
        }
        for request in server.join().unwrap() {
            assert_eq!(request["method"], RANKING);
            assert_eq!(request["sign"], sign(&request, "test-secret"));
            let payload: Value = serde_json::from_str(&request["360buy_param_json"]).unwrap();
            assert_eq!(
                payload,
                json!({"RankGoodsReq": {"rankId": 200000, "sortType": 3, "pageIndex": 1, "pageSize": 20}})
            );
        }
        for (min, max) in [(Some(0.0), None), (None, Some(100.0))] {
            let error = search_query(" ", min, max).unwrap_err();
            assert_eq!(error.status, 400);
            assert!(error.message.contains("热销榜不支持价格筛选"));
        }
    }

    #[test]
    fn ranking_preserves_empty_results_and_validates_its_own_fields() {
        for data in [Value::Null, json!([]), json!({"rankGoodsResp": []})] {
            assert!(parse_rank_items(&json!({"data": data})).unwrap().is_empty());
        }
        let ranked = json!({"itemId": "ranked-1", "skuName": "笔记本", "wlprice": 100,
            "imageUrl": "https://evil.invalid/tracker"});
        let result =
            parse_rank_items(&json!({"data": {"rankGoodsResp": [ranked.clone(), ranked.clone()]}}))
                .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].price, 100.0);
        assert!(result[0].image_url.is_empty());
        for price in [Value::Null, json!(-1), json!("NaN"), json!("Infinity")] {
            let mut invalid = ranked.clone();
            invalid["wlprice"] = price;
            invalid["purchasePriceInfo"] = json!({"purchasePrice": 1});
            assert!(
                parse_rank_items(&json!({"data": [invalid]}))
                    .unwrap()
                    .is_empty()
            );
        }
        assert!(parse_rank_items(&json!({"data": {"rankGoodsResp": "invalid"}})).is_err());
        assert!(
            parse_rank_items(&json!({"data": [goods()]}))
                .unwrap()
                .is_empty()
        );
        let rows: Vec<_> = (0..25)
            .map(|i| {
                let mut row = ranked.clone();
                row["itemId"] = json!(format!("item-{i}"));
                row
            })
            .collect();
        assert_eq!(parse_rank_items(&json!({"data": rows})).unwrap().len(), 20);
    }

    #[test]
    fn keyword_errors_do_not_fall_back_to_ranking() {
        let body = json!({"jd_union_open_goods_query_responce": {"code": "0", "queryResult":
            json!({"code": 403, "message": "无访问权限"}).to_string()}})
        .to_string();
        let (endpoint, server) = mock(vec![(200, body)]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        let error = client
            .search(search_query(" 茶叶 ", None, None).unwrap())
            .unwrap_err();
        assert!(error.message.contains(GOODS));
        assert!(error.message.contains("可清空关键词仅浏览热销榜"));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], GOODS);
        let payload: Value = serde_json::from_str(&requests[0]["360buy_param_json"]).unwrap();
        assert_eq!(
            payload,
            json!({"goodsReqDTO": {"sceneId": 1, "keyword": "茶叶", "pageIndex": 1, "pageSize": 20}})
        );
    }

    #[test]
    fn handles_documented_envelopes_empty_results_and_redacts_errors() {
        let result = decode_result(
            serde_json::from_str(&envelope(GOODS, "queryResult", json!([goods()]))).unwrap(),
            GOODS,
            "queryResult",
        )
        .unwrap();
        assert_eq!(parse_items(&result).unwrap().len(), 1);
        let documented = json!({"jd_union_open_goods_query_responce": {"queryResult": {"code": "200", "data": {"goodsResp": goods()}}}});
        assert_eq!(
            parse_items(&decode_result(documented, GOODS, "queryResult").unwrap()).unwrap()[0]
                .price,
            99.9
        );
        for data in [json!([]), Value::Null] {
            assert!(parse_items(&json!({"data": data})).unwrap().is_empty());
        }
        // 可信错误文案（zh_desc/message）透出便于自查；未知字段与超长/控制字符内容仍脱敏
        for body in [
            json!({"error_response": {"code": "403", "unknown": "test-secret"}}),
            json!({"code": "408", "zh_desc": "\u{1}控制字符test-secret"}),
            json!({"jd_union_open_goods_query_responce": {"queryResult": {"code": 408, "message": format!("长{}", "长".repeat(200))}}}),
            json!({"unexpected": "test-secret"}),
            json!({"jd_union_open_goods_query_responce": {"queryResult": "invalid test-secret"}}),
            json!({"jd_union_open_goods_query_responce": {"test-secret": {}}}),
        ] {
            let error = decode_result(body, GOODS, "queryResult").unwrap_err();
            assert_eq!(error.status, 502);
            assert!(!error.output().to_string().contains("test-secret"));
        }
        let error = decode_result(
            json!({"error_response": {"code": "403", "zh_desc": "签名验证失败", "other": "test-secret"}}),
            GOODS,
            "queryResult",
        )
        .unwrap_err();
        let text = error.output().to_string();
        assert!(text.contains("签名验证失败"), "{text}");
        assert!(!text.contains("test-secret"));
        let error = decode_result(
            json!({"jd_union_open_goods_query_responce": {"queryResult": {"code": 403, "message": "无访问权限", "requestId": "test-secret"}}}),
            GOODS,
            "queryResult",
        )
        .unwrap_err();
        let text = error.output().to_string();
        assert!(text.contains("无访问权限"), "{text}");
        assert!(text.contains("申请该 API 权限"), "{text}");
        assert!(!text.contains("test-secret"));
    }

    #[test]
    fn validates_urls_and_uses_real_price_only() {
        use items::valid_jd_url;
        assert!(valid_jd_url("https://u.jd.com/abc", false));
        assert!(valid_jd_url("http://union-click.jd.com/jdc?x=1", false));
        for link in [
            "javascript:alert(1)",
            "https://jd.com.evil.invalid/a",
            "https://evil.invalid/",
            "https://user@u.jd.com/a",
            "https://u.jd.com/\na",
        ] {
            assert!(!valid_jd_url(link, false));
        }
        let mut row = goods();
        row["priceInfo"] = json!({"lowestCouponPrice": 1});
        assert!(parse_items(&json!({"data": [row]})).unwrap().is_empty());
        let mut row = goods();
        row["imageInfo"]["imageList"][0]["url"] = json!("https://evil.invalid/tracker");
        let result = parse_items(&json!({"data": [row.clone(), row]})).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].image_url.is_empty());
    }

    #[test]
    fn coupon_range_does_not_filter_by_reference_price() {
        let mut item = goods();
        item["priceInfo"] = json!({"price": 120, "lowestCouponPrice": 80});
        let (endpoint, server) = mock(vec![(200, envelope(GOODS, "queryResult", json!([item])))]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        let result = client
            .search(search_query("茶", None, Some(100.0)).unwrap())
            .unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["price"], 120.0);
        let requests = server.join().unwrap();
        let query: Value = serde_json::from_str(&requests[0]["360buy_param_json"]).unwrap();
        assert_eq!(query["goodsReqDTO"]["priceto"], 100.0);
    }

    #[test]
    fn sends_signed_requests_and_rechecks_item_before_promoting() {
        let promotion_link = format!("https://union-click.jd.com/jdc?x={}", "a".repeat(800));
        let (endpoint, server) = mock(vec![
            (200, envelope(GOODS, "queryResult", json!([goods()]))),
            (
                200,
                envelope(PROMOTION, "getResult", json!({"clickURL": promotion_link})),
            ),
        ]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        let product = client.promote("union_item-1", None).unwrap();
        assert_eq!(product["productName"], "岩茶礼盒");
        assert_eq!(product["productPrice"], "¥99.90（京东参考价）");
        assert_eq!(product["productUrl"], promotion_link);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert_eq!(request["sign"], sign(request, "test-secret"));
            assert!(!request.contains_key("param_json"));
            assert!(!request.values().any(|v| v.contains("test-secret")));
        }
        let lookup: Value = serde_json::from_str(&requests[0]["360buy_param_json"]).unwrap();
        assert_eq!(
            lookup,
            json!({"goodsReqDTO": {"sceneId": 1, "itemIds": ["union_item-1"]}})
        );
        let promote: Value = serde_json::from_str(&requests[1]["360buy_param_json"]).unwrap();
        assert_eq!(
            promote,
            json!({"promotionCodeReq": {"sceneId": 1, "materialId": "union_item-1", "siteId": "1234", "positionId": 5678}})
        );
    }

    #[test]
    fn missing_item_does_not_call_promotion() {
        let (endpoint, server) = mock(vec![(200, envelope(GOODS, "queryResult", json!([])))]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        assert_eq!(client.promote("union_item-1", None).unwrap_err().status, 404);
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn promote_falls_back_to_displayed_details_when_goods_query_is_denied() {
        let denied = json!({"jd_union_open_goods_query_responce": {"code": "0",
            "queryResult": json!({"code": 403, "message": "无访问权限"}).to_string()}})
        .to_string();
        let promotion_link = "https://union-click.jd.com/jdc?x=fallback".to_owned();
        let (endpoint, server) = mock(vec![
            (200, denied),
            (
                200,
                envelope(PROMOTION, "getResult", json!({"clickURL": promotion_link})),
            ),
        ]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        let product = client
            .promote("union_item-1", Some(("囤货装纸巾", 6.59)))
            .unwrap();
        assert_eq!(product["productName"], "囤货装纸巾");
        assert_eq!(product["productPrice"], "¥6.59（京东参考价）");
        assert_eq!(
            product["productUrl"],
            "https://union-click.jd.com/jdc?x=fallback"
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["method"], GOODS);
        assert_eq!(requests[1]["method"], PROMOTION);
        let promote: Value = serde_json::from_str(&requests[1]["360buy_param_json"]).unwrap();
        assert_eq!(promote["promotionCodeReq"]["materialId"], "union_item-1");
    }

    #[test]
    fn promote_without_fallback_reports_permission_error() {
        let denied = json!({"jd_union_open_goods_query_responce": {"code": "0",
            "queryResult": json!({"code": 403, "message": "无访问权限"}).to_string()}})
        .to_string();
        let (endpoint, server) = mock(vec![(200, denied)]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        let error = client.promote("union_item-1", None).unwrap_err();
        assert!(error.permission_denied);
        assert!(error.message.contains("无访问权限"));
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn promote_does_not_degrade_on_non_permission_failures() {
        let (endpoint, server) = mock(vec![(500, String::new())]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        let error = client
            .promote("union_item-1", Some(("囤货装纸巾", 6.59)))
            .unwrap_err();
        assert!(!error.permission_denied);
        assert_eq!(error.status, 502);
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn promote_fallback_flags_are_validated() {
        assert!(promote_fallback(None, None).unwrap().is_none());
        assert_eq!(
            promote_fallback(Some("囤货装纸巾"), Some(6.59)).unwrap(),
            Some(("囤货装纸巾", 6.59))
        );
        let long = "长".repeat(201);
        for (name, price) in [
            (Some("名"), None),
            (None, Some(6.59)),
            (Some(" \n\t "), Some(6.59)),
            (Some("名\u{1}"), Some(6.59)),
            (Some(long.as_str()), Some(6.59)),
            (Some("名"), Some(0.0)),
            (Some("名"), Some(-1.0)),
            (Some("名"), Some(f64::NAN)),
            (Some("名"), Some(1_000_001.0)),
        ] {
            assert_eq!(promote_fallback(name, price).unwrap_err().status, 400);
        }
    }

    #[test]
    fn does_not_follow_gateway_redirects_or_echo_response_body() {
        let (endpoint, server) = mock(vec![(302, "test-secret".into())]);
        let mut client = JdClient::new(config()).unwrap();
        client.endpoint = endpoint;
        let error = client
            .search(search_query("茶", None, None).unwrap())
            .unwrap_err();
        assert_eq!(error.status, 502);
        assert!(!error.output().to_string().contains("test-secret"));
        assert_eq!(server.join().unwrap().len(), 1);
    }
}
