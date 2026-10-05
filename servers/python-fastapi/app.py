"""GET /products?category=&min_price=&max_price=&sort=&limit=

Filter + sort + serialise an in-memory catalogue. No caching, no memoisation,
no pre-sorted copies, no pre-serialised JSON: every request does the full work.
"""
import json
import math
import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class Product(BaseModel):
    id: int
    name: str
    category: str
    price: float
    rating: float
    stock: int
    tags: list[str]
    # Plain string on purpose. A datetime type would reformat it on the way out
    # and break JSON parity with the other three stacks.
    created_at: str


class ProductsPage(BaseModel):
    total: int
    items: list[Product]


PRODUCTS_PATH = os.environ.get("PRODUCTS_PATH", "data/products.json")
with open(PRODUCTS_PATH, encoding="utf-8") as fh:
    _raw = json.load(fh)

# Products are held as Pydantic model instances, so the per-request response-model
# pass short-circuits to an identity check (revalidate_instances defaults to
# 'never') instead of rebuilding 50 models. Declaring ProductsPage as the return
# type is what puts FastAPI on its dump_json path, where pydantic-core writes the
# response bytes in one pass: no intermediate dict, no json.dumps. That path exists
# from FastAPI 0.130 onwards, which is why requirements.txt pins the version.
PRODUCTS: list[Product] = [Product(**row) for row in _raw]

# Per-category index, built once at startup, in id order. Startup is not measured.
INDEX: dict[str, list[Product]] = {}
for _p in PRODUCTS:
    INDEX.setdefault(_p.category, []).append(_p)
print(f"fastapi: categories={len(INDEX)} products={len(PRODUCTS)}", flush=True)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(RequestValidationError)
async def on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI answers validation errors with 422 by default; all four stacks use 400."""
    return JSONResponse(status_code=400, content={"error": "invalid query parameters"})


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


# async def: the handler does no I/O, so this avoids the threadpool hop.
@app.get("/products")
async def products(
    category: str,
    min_price: float = 0.0,
    max_price: float | None = None,
    sort: Literal["price_asc", "price_desc", "rating_desc"] = "price_asc",
    limit: int = Query(20, ge=1, le=100),
) -> ProductsPage:
    if not math.isfinite(min_price) or (max_price is not None and not math.isfinite(max_price)):
        # Same body shape as the validation handler above, and as the other three
        # stacks: one error format per server, not two.
        raise HTTPException(status_code=400, detail={"error": "min_price and max_price must be finite numbers"})

    # 1. candidates for the category
    candidates = INDEX.get(category)
    if candidates is None:
        return ProductsPage(total=0, items=[])

    # 2. price window + in stock
    hi = math.inf if max_price is None else max_price
    kept = [p for p in candidates if p.stock > 0 and min_price <= p.price <= hi]
    # 3. total before the limit
    total = len(kept)
    # 4. sort, ties always broken by id ascending
    if sort == "price_asc":
        kept.sort(key=lambda p: (p.price, p.id))
    elif sort == "price_desc":
        kept.sort(key=lambda p: (-p.price, p.id))
    else:
        kept.sort(key=lambda p: (-p.rating, p.id))
    # 5. first `limit`, 6. respond 200 application/json
    return ProductsPage(total=total, items=kept[:limit])
