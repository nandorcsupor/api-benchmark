// GET /products?category=&min_price=&max_price=&sort=&limit=
// Filter + sort + serialise an in-memory catalogue. No caching, no memoisation,
// no pre-sorted copies, no pre-serialised JSON: every request does the full work.
use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct Product {
    id: u32,
    name: String,
    category: String,
    price: f64,
    rating: f64,
    stock: u32,
    tags: Vec<String>,
    created_at: String,
}

#[derive(Serialize)]
struct Page<'a> {
    total: usize,
    items: Vec<&'a Product>,
}

#[derive(Deserialize)]
struct Params {
    category: Option<String>,
    min_price: Option<f64>,
    max_price: Option<f64>,
    sort: Option<String>,
    limit: Option<i64>,
}

struct AppState {
    index: HashMap<String, Vec<Product>>,
}

fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": msg }))).into_response()
}

async fn list_products(
    State(state): State<Arc<AppState>>,
    params: Result<Query<Params>, QueryRejection>,
) -> Response {
    let Ok(Query(p)) = params else {
        return bad_request("invalid query parameters");
    };
    let Some(category) = p.category else {
        return bad_request("category is required");
    };
    let min_price = p.min_price.unwrap_or(0.0);
    let max_price = p.max_price.unwrap_or(f64::INFINITY);
    if !min_price.is_finite() || (p.max_price.is_some() && !max_price.is_finite()) {
        return bad_request("min_price and max_price must be finite numbers");
    }
    let sort = p.sort.as_deref().unwrap_or("price_asc");
    if !matches!(sort, "price_asc" | "price_desc" | "rating_desc") {
        return bad_request("sort must be price_asc, price_desc or rating_desc");
    }
    let limit = p.limit.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return bad_request("limit must be between 1 and 100");
    }

    // 1. candidates for the category
    let Some(candidates) = state.index.get(&category) else {
        return Json(Page { total: 0, items: Vec::new() }).into_response();
    };
    // 2. price window + in stock
    let mut kept: Vec<&Product> = candidates
        .iter()
        .filter(|p| p.stock > 0 && p.price >= min_price && p.price <= max_price)
        .collect();
    // 3. total before the limit
    let total = kept.len();
    // 4. sort, ties always broken by id ascending
    match sort {
        "price_asc" => kept.sort_by(|a, b| {
            a.price.partial_cmp(&b.price).unwrap().then_with(|| a.id.cmp(&b.id))
        }),
        "price_desc" => kept.sort_by(|a, b| {
            b.price.partial_cmp(&a.price).unwrap().then_with(|| a.id.cmp(&b.id))
        }),
        _ => kept.sort_by(|a, b| {
            b.rating.partial_cmp(&a.rating).unwrap().then_with(|| a.id.cmp(&b.id))
        }),
    }
    // 5. first `limit`
    kept.truncate(limit as usize);
    // 6. 200 application/json
    Json(Page { total, items: kept }).into_response()
}

async fn health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() {
    let path = std::env::var("PRODUCTS_PATH").unwrap_or_else(|_| "data/products.json".to_string());
    let raw = std::fs::read_to_string(&path).expect("read products.json");
    let products: Vec<Product> = serde_json::from_str(&raw).expect("parse products.json");

    // Per-category index, built once at startup, in id order. Startup is not measured.
    let mut index: HashMap<String, Vec<Product>> = HashMap::new();
    for p in products {
        index.entry(p.category.clone()).or_default().push(p);
    }

    let parallelism = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    println!("axum: available_parallelism={parallelism}");
    println!("axum: categories={} products={}", index.len(), index.values().map(Vec::len).sum::<usize>());

    let app = Router::new()
        .route("/products", get(list_products))
        .route("/health", get(health))
        .with_state(Arc::new(AppState { index }));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.expect("bind 0.0.0.0:8080");
    println!("axum: listening on 0.0.0.0:8080");
    axum::serve(listener, app).await.unwrap();
}
