"""WB search backend. Internal search endpoint is NOT official Seller API."""
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()

# The FIRST URL and parameter combination below were observed returning HTTP 200
# in the user's 2026-11-11 HAR. These are UNDOCUMENTED web-site endpoints.
# We deliberately do not replay HAR cookies, auth headers or device identifiers.
WB_SEARCH_TARGETS = (
    ("https://www.wildberries.ru/__internal/u-search/exactmatch/ru/common/v18/search", "64"),
    ("https://search.wb.ru/exactmatch/ru/common/v18/search", "1"),
    ("https://search.wb.ru/exactmatch/ru/common/v5/search", "1"),
)
DEFAULT_DESTINATION = int(os.environ.get("WB_DESTINATION", "1259570991"))


class Product(BaseModel):
    position: int
    id: str
    name: str
    brand: str = ""
    price_rub: float | None = None
    basic_price_rub: float | None = None
    rating: float | None = None
    feedbacks: int | None = None


class SearchResponse(BaseModel):
    query: str
    source: str = "unofficial Wildberries site search interface"
    products: list[Product]
    total_returned: int
    warning: str = (
        "JSON product price is not guaranteed to match rendered storefront price. "
        "A supplied HTML snapshot showed 359 RUB in JSON versus 348 RUB in the page. "
        "Basic price is not the seller's price before SPP; SPP is unknown."
    )


def extract_products(payload: Any) -> list[Product]:
    if not isinstance(payload, dict):
        raise ValueError("WB payload is not an object")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    cards = data.get("products")
    if cards is None:
        cards = data.get("cards")
    if not isinstance(cards, list):
        raise ValueError("WB products array missing or schema changed")
    result = []
    for card in cards[:10]:
        if not isinstance(card, dict):
            continue
        sizes = card.get("sizes")
        price = {}
        if isinstance(sizes, list):
            for size in sizes:
                if isinstance(size, dict) and isinstance(size.get("price"), dict):
                    price = size["price"]
                    if price.get("product") is not None:
                        break
        # The known *U and sizes.price fields represent kopecks in observed schemas.
        raw_sale = price.get("product", card.get("salePriceU"))
        raw_basic = price.get("basic", card.get("priceU"))

        def rub(value: Any) -> float | None:
            try:
                number = float(value) / 100
                return round(number, 2) if number > 0 else None
            except (TypeError, ValueError):
                return None

        def maybe_int(value: Any) -> int | None:
            try:
                return int(value) if value is not None else None
            except (ValueError, TypeError):
                return None

        def maybe_float(value: Any) -> float | None:
            try:
                return float(value) if value is not None else None
            except (ValueError, TypeError):
                return None

        result.append(Product(
            position=len(result) + 1,
            id=str(card.get("id") or card.get("nmId") or ""),
            name=str(card.get("name") or "Без названия"),
            brand=str(card.get("brand") or ""),
            price_rub=rub(raw_sale),
            basic_price_rub=rub(raw_basic),
            rating=maybe_float(card.get("reviewRating", card.get("rating"))),
            feedbacks=maybe_int(card.get("feedbacks")),
        ))
    return result


class WBSearchUnavailable(Exception):
    def __init__(self, attempts: list[str]):
        self.attempts = attempts
        super().__init__("WB search unavailable")


async def fetch_wb_top10(
    client: httpx.AsyncClient, query: str, destination: int
) -> tuple[list[Product], str]:
    """Try actual site search first; keep errors safe to expose in diagnostics."""
    attempts: list[str] = []
    for url, app_type in WB_SEARCH_TARGETS:
        params = {
            "appType": app_type,
            "curr": "rub",
            "dest": str(destination),
            "hide_vflags": "4294967296",
            "inheritFilters": "true",
            "lang": "ru",
            "locale": "ru",
            "query": query,
            "resultset": "catalog",
            "sort": "popular",
            "spp": "30",  # WB search request parameter; NOT observed competitor SPP.
            "suppressSpellcheck": "false",
        }
        try:
            response = await client.get(url, params=params)
            response.raise_for_status()
            products = extract_products(response.json())
            if products and any(p.price_rub is not None for p in products):
                return products, url.split("?")[0]
            attempts.append(f"{url}: no priced products")
        except httpx.HTTPStatusError as exc:
            attempts.append(f"{url}: HTTP {exc.response.status_code}")
        except httpx.HTTPError as exc:
            attempts.append(f"{url}: {type(exc).__name__}")
        except (ValueError, TypeError, KeyError) as exc:
            attempts.append(f"{url}: invalid JSON/schema ({type(exc).__name__})")
    raise WBSearchUnavailable(attempts)


@router.get("/api/wb/search", response_model=SearchResponse)
async def wb_search(
    query: str = Query(min_length=2, max_length=150),
    destination: int = Query(
        default=DEFAULT_DESTINATION, description="WB destination/region (configurable)"
    ),
):
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(12.0),
        follow_redirects=False,
        headers={
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 (compatible; MarketCalculate/0.4)",
            "Referer": "https://www.wildberries.ru/",
        },
    ) as client:
        try:
            products, source = await fetch_wb_top10(client, query, destination)
        except WBSearchUnavailable as exc:
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "WB search temporarily unavailable or payload changed",
                    "attempts": exc.attempts,
                },
            ) from exc
    return SearchResponse(
        query=query,
        products=products,
        total_returned=len(products),
        source=source,
    )
