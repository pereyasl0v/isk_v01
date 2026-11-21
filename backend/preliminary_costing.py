"""Pre-purchase landed-cost scenarios based on the user's two China shipping workbooks."""
from __future__ import annotations

import math
import uuid
from typing import Any


DEFAULT_ROSTOV_USD_RATE = 95
DEFAULT_CONTAINER_VOLUME_M3 = 65
DEFAULT_CONTAINER_COST_USD = 17000

DEFAULT_ROUTE1 = {
    "yuanToRubRate": 14.2,
    "purchaseMarkupPercent": 7.0,
    # The workbook formula is 17,000 * 95 / 65 * product volume.
    "freightRateRubPerM3": DEFAULT_CONTAINER_COST_USD * DEFAULT_ROSTOV_USD_RATE / DEFAULT_CONTAINER_VOLUME_M3,
    "dutyableFreightPercent": 60.0,
    "vatPercent": 22.0,
    "ownTaxPercent": 20.0,
    "deliveryToSpbRub": 0.0,
    "loadersRub": 0.0,
    "unloadersRub": 0.0,
    "otherRub": 0.0,
    "allocationMethod": "volume",
}
DEFAULT_ROUTE2 = {
    "purchaseYuanToRubRate": 11.8,
    "usdToYuanRate": 6.8,
    "freightYuanToRubRate": 12.4,
    "autoFreightUsdPerKg": 3.2,
    "packagingPerBoxUsd": 3.0,
    "boxCount": 0.0,
    "grossWeightKg": 0.0,
    "deliveryToSpbRub": 0.0,
    "deliveryToHomeRub": 0.0,
    "loadersRub": 0.0,
    "packingRub": 0.0,
    "otherRub": 0.0,
}

PRODUCT_NUMBER_FIELDS = (
    "unitPriceYuan",
    "deliveryToSashaYuan",
    "deliveryToGuangzhouYuan",
    "dutyPercent",
    "volumeM3",
    "lengthCm",
    "widthCm",
    "heightCm",
    "grossWeightKg",
    "netWeightKg",
    "unitNetWeightG",
)
ROUTE1_NUMBER_FIELDS = tuple(k for k in DEFAULT_ROUTE1 if k not in ("allocationMethod",))
ROUTE2_NUMBER_FIELDS = tuple(DEFAULT_ROUTE2)


def _number(value: Any, field: str, default: float = 0.0, maximum: float = 1_000_000_000) -> float:
    if value is None or value == "":
        value = default
    if isinstance(value, bool):
        raise ValueError(f"Проверьте числовое поле «{field}».")
    try:
        result = float(str(value).replace(",", ".").strip())
    except (TypeError, ValueError):
        raise ValueError(f"Проверьте числовое поле «{field}».") from None
    if not math.isfinite(result) or result < 0 or result > maximum:
        raise ValueError(f"Недопустимое значение в поле «{field}».")
    return result


def clean_preliminary_cost(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Некорректный предварительный расчёт.")
    products_raw = raw.get("products")
    if not isinstance(products_raw, list) or not 1 <= len(products_raw) <= 100:
        raise ValueError("Добавьте от 1 до 100 товаров.")

    products = []
    ids = set()
    for index, item in enumerate(products_raw, 1):
        if not isinstance(item, dict):
            raise ValueError("Некорректная строка товара.")
        name = str(item.get("name") or "").strip()
        if not name or len(name) > 300:
            raise ValueError(f"Укажите наименование товара №{index} (до 300 символов).")
        product_id = str(item.get("id") or uuid.uuid4().hex).strip()
        if not product_id or len(product_id) > 80 or product_id in ids:
            raise ValueError("Идентификаторы товаров должны быть уникальными.")
        ids.add(product_id)
        quantity = _number(item.get("quantity", 1), f"Количество · {name}", 1, 10_000_000)
        if quantity < 1 or not quantity.is_integer():
            raise ValueError(f"Количество товара «{name}» должно быть целым числом больше нуля.")
        clean = {
            "id": product_id,
            "name": name,
            "article": str(item.get("article") or "").strip()[:80],
            "quantity": int(quantity),
        }
        for field in PRODUCT_NUMBER_FIELDS:
            clean[field] = _number(item.get(field), field)
        has_dimensions = any(clean[field] for field in ("lengthCm", "widthCm", "heightCm"))
        if not has_dimensions and 0 < clean["volumeM3"] < 0.1:
            raise ValueError(f"Сохранённый ручной объём товара «{name}» должен быть не меньше 0,1 м³.")
        if clean["dutyPercent"] > 100:
            raise ValueError(f"Пошлина для товара «{name}» не может быть больше 100%.")
        products.append(clean)

    route1_raw = raw.get("route1") if isinstance(raw.get("route1"), dict) else {}
    route1 = {
        key: _number(route1_raw.get(key), key, default)
        for key, default in DEFAULT_ROUTE1.items()
        if key != "allocationMethod"
    }
    if "usdToRubRate" in route1_raw:
        route1["usdToRubRate"] = _number(route1_raw["usdToRubRate"], "Курс доллара")
    if "containerCostUsd" in route1_raw or "containerVolumeM3" in route1_raw:
        route1["containerCostUsd"] = _number(route1_raw.get("containerCostUsd"), "Стоимость контейнера")
        volume = _number(route1_raw.get("containerVolumeM3"), "Полезный объём контейнера")
        if volume <= 0:
            raise ValueError("Укажите полезный объём контейнера больше нуля.")
        route1["containerVolumeM3"] = volume
    route1["allocationMethod"] = str(route1_raw.get("allocationMethod") or "volume")
    if route1["allocationMethod"] not in ("volume", "weight", "quantity", "value"):
        raise ValueError("Неизвестный способ распределения дополнительных расходов для маршрута через Ростов.")
    for key in ("dutyableFreightPercent", "vatPercent", "ownTaxPercent", "purchaseMarkupPercent"):
        if route1[key] > 100:
            raise ValueError(f"Поле «{key}» не может быть больше 100%.")

    route2_raw = raw.get("route2") if isinstance(raw.get("route2"), dict) else {}
    route2 = {
        key: _number(route2_raw.get(key), key, default)
        for key, default in DEFAULT_ROUTE2.items()
    }
    result = {"products": products, "route1": route1, "route2": route2}
    if "yuanToRubRate" in raw:
        result["yuanToRubRate"] = _number(raw["yuanToRubRate"], "Курс юаня")
    if "packagingWeightPercent" in raw:
        result["packagingWeightPercent"] = _number(raw["packagingWeightPercent"], "Вес упаковки от нетто")
    return result


def _shares(products: list[dict], method: str) -> list[float]:
    if method == "volume":
        weights = [p["volumeM3"] for p in products]
    elif method == "weight":
        weights = [
            p["grossWeightKg"] or p["netWeightKg"]
            for p in products
        ]
    elif method == "value":
        weights = [p["unitPriceYuan"] * p["quantity"] for p in products]
    else:
        weights = [float(p["quantity"]) for p in products]
    total = sum(weights)
    if total <= 0:
        weights = [float(p["quantity"]) for p in products]
        total = sum(weights)
    return [weight / total for weight in weights] if total else [0.0 for _ in products]


def _batch_volume_m3(product: dict) -> float:
    length, width, height = (product.get(field, 0) for field in ("lengthCm", "widthCm", "heightCm"))
    if not any((length, width, height)):
        return product["volumeM3"]
    return length * width * height * product["quantity"] / 1_000_000


def calculate_preliminary_cost(data: dict) -> dict:
    products = [
        {
            **product,
            "volumeM3": _batch_volume_m3(product),
            "netWeightKg": (
                product["unitNetWeightG"] * product["quantity"] / 1000
                if product["unitNetWeightG"] > 0 else product["netWeightKg"]
            ),
        }
        for product in data["products"]
    ]
    r1 = data["route1"]
    r2 = data["route2"]
    usd_rate = r1.get("usdToRubRate", DEFAULT_ROSTOV_USD_RATE)
    if "containerCostUsd" in r1:
        freight_rate = r1["containerCostUsd"] * usd_rate / r1["containerVolumeM3"]
    else:
        freight_rate = r1["freightRateRubPerM3"] * (usd_rate / DEFAULT_ROSTOV_USD_RATE)
    common_rate = data.get("yuanToRubRate")
    warnings = []

    packaging_percent = data.get("packagingWeightPercent")
    route1_shares = _shares(products, r1["allocationMethod"])
    route1_shared = sum(r1[key] for key in (
        "deliveryToSpbRub", "loadersRub", "unloadersRub", "otherRub"
    )) if packaging_percent is None else 0
    route1_rows = []
    for product, share in zip(products, route1_shares):
        quantity = product["quantity"]
        supplier_yuan = quantity * product["unitPriceYuan"] + product["deliveryToSashaYuan"]
        goods_rub = supplier_yuan * (common_rate if common_rate is not None else r1["yuanToRubRate"]) * (1 + r1["purchaseMarkupPercent"] / 100)
        freight_rub = product["volumeM3"] * freight_rate
        taxable_freight = freight_rub * r1["dutyableFreightPercent"] / 100
        duty_goods = goods_rub * product["dutyPercent"] / 100
        duty_freight = taxable_freight * product["dutyPercent"] / 100
        vat_goods = goods_rub * r1["vatPercent"] / 100
        vat_freight = taxable_freight * r1["vatPercent"] / 100
        tax_base = freight_rub + goods_rub + duty_goods + duty_freight + vat_goods + vat_freight
        own_tax = tax_base * r1["ownTaxPercent"] / 100
        extra = route1_shared * share
        base_total = tax_base + own_tax
        total = base_total + extra
        route1_rows.append({
            "id": product["id"],
            "supplierTotalYuan": supplier_yuan,
            "goodsRub": goods_rub,
            "freightToRostovRub": freight_rub,
            "taxableFreightRub": taxable_freight,
            "dutyGoodsRub": duty_goods,
            "dutyFreightRub": duty_freight,
            "vatGoodsRub": vat_goods,
            "vatFreightRub": vat_freight,
            "ownTaxRub": own_tax,
            "allocatedAdditionalRub": extra,
            "allocationShare": share,
            "totalRub": total,
            "costPerUnit": total / quantity,
        })
        if freight_rate and product["volumeM3"] <= 0:
            warnings.append(f"«{product['name']}»: укажите длину, ширину и высоту одной штуки для расчёта доставки через Ростов.")

    total_quantity = sum(p["quantity"] for p in products)
    route1_total = sum(row["totalRub"] for row in route1_rows)
    route1_summary = {
        "totalRub": route1_total,
        "averageCostPerUnit": route1_total / total_quantity if total_quantity else 0.0,
        "sharedExpensesRub": route1_shared,
        "totalQuantity": total_quantity,
    }

    net_weights = [p["netWeightKg"] for p in products]
    total_net_weight = sum(net_weights)
    if packaging_percent is None:
        gross_weight = r2["grossWeightKg"] or total_net_weight
    else:
        gross_weight = total_net_weight * (1 + packaging_percent / 100)
    if gross_weight < total_net_weight:
        warnings.append("Маршрут через Южные ворота: брутто меньше суммарного нетто. Для расчёта использован вес нетто.")
        gross_weight = total_net_weight
    packaging_weight = max(0.0, gross_weight - total_net_weight)
    if gross_weight <= 0:
        route2_shares = _shares(products, "quantity")
        warnings.append("Маршрут через Южные ворота: укажи вес нетто товара и брутто всей партии для точного распределения доставки.")
    else:
        route2_shares = [
            (net + (packaging_weight * net / total_net_weight if total_net_weight > 0 else 0.0)) / gross_weight
            for net in net_weights
        ]
        if total_net_weight <= 0:
            route2_shares = _shares(products, "quantity")
            warnings.append("Маршрут через Южные ворота: укажи вес нетто одной единицы для точного распределения доставки.")

    transport_usd = r2["autoFreightUsdPerKg"] * gross_weight + r2["packagingPerBoxUsd"] * r2["boxCount"]
    transport_rub = transport_usd * r2["usdToYuanRate"] * (common_rate if common_rate is not None else r2["freightYuanToRubRate"])
    route2_shared = sum(r2[key] for key in (
        "deliveryToSpbRub", "deliveryToHomeRub", "loadersRub", "packingRub", "otherRub"
    )) if packaging_percent is None else 0
    route2_rows = []
    for product, net, share in zip(products, net_weights, route2_shares):
        quantity = product["quantity"]
        allocated_packaging = packaging_weight * net / total_net_weight if total_net_weight > 0 else 0.0
        allocated_gross = net + allocated_packaging
        purchase_yuan = quantity * product["unitPriceYuan"] + product["deliveryToGuangzhouYuan"]
        purchase_rub = purchase_yuan * (common_rate if common_rate is not None else r2["purchaseYuanToRubRate"])
        allocated_transport = transport_rub * share
        allocated_shared = route2_shared * share
        total = purchase_rub + allocated_transport + allocated_shared
        route2_rows.append({
            "id": product["id"],
            "netWeightKg": net,
            "allocatedPackagingKg": allocated_packaging,
            "allocatedGrossWeightKg": allocated_gross,
            "allocationShare": share,
            "purchaseTotalYuan": purchase_yuan,
            "purchaseRub": purchase_rub,
            "transportRub": allocated_transport,
            "sharedExpensesRub": allocated_shared,
            "totalRub": total,
            "costPerUnit": total / quantity,
        })
        if (r2["autoFreightUsdPerKg"] or r2["packagingPerBoxUsd"]) and gross_weight <= 0:
            warnings.append(f"«{product['name']}»: недостаточно данных о весе для расчёта автодоставки.")

    route2_total = sum(row["totalRub"] for row in route2_rows)
    route2_summary = {
        "totalRub": route2_total,
        "averageCostPerUnit": route2_total / total_quantity if total_quantity else 0.0,
        "transportRub": transport_rub,
        "sharedExpensesRub": route2_shared,
        "grossWeightKg": gross_weight,
        "netWeightKg": total_net_weight,
        "totalQuantity": total_quantity,
    }
    if route1_total < route2_total:
        cheaper = "rostov"
    elif route2_total < route1_total:
        cheaper = "south_gates"
    else:
        cheaper = None

    return {
        "products": [
            {
                **product,
                "route1": route1_row,
                "route2": route2_row,
                "differencePerUnit": route1_row["costPerUnit"] - route2_row["costPerUnit"],
            }
            for product, route1_row, route2_row in zip(products, route1_rows, route2_rows)
        ],
        "summary": {
            "route1": route1_summary,
            "route2": route2_summary,
            "cheaperRoute": cheaper,
            "differenceRub": abs(route1_total - route2_total),
        },
        "warnings": list(dict.fromkeys(warnings)),
    }
