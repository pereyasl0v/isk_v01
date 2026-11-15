"""Cost-of-goods calculations and legacy Excel import for the market calculator."""
from __future__ import annotations

from datetime import date, datetime
from io import BytesIO
import math
import uuid
from typing import Any

from openpyxl import load_workbook


def number(value: Any) -> float:
    try:
        result = float(str(value if value is not None else 0).replace(",", ".").strip() or 0)
        return result if math.isfinite(result) else 0.0
    except (TypeError, ValueError):
        return 0.0


def calculate_product_cost(product: dict, shipment: dict | None, assigned: list[dict]) -> dict:
    """Return per-unit landed cost, distributing shipment expenses once across its products."""
    quantity = max(0.0, number(product.get("quantity", 1)))
    price_yuan = max(0.0, number(product.get("yuan")))
    purchase_rate = max(0.0, number(product.get("rate")))
    local_yuan = max(0.0, number(product.get("deliveryToGuangzhouYuan")))
    if not shipment or not product.get("shipmentId"):
        unit_cost = price_yuan * purchase_rate + max(0.0, number(product.get("freight")))
        return {
            "costPerUnit": unit_cost, "purchaseRub": unit_cost * quantity,
            "transportRub": 0.0, "sharedExpensesRub": 0.0,
            "allocationShare": 0.0, "allocatedGrossWeightKg": 0.0,
            "shipmentName": None, "source": "manual",
        }

    lines = [p for p in assigned if str(p.get("shipmentId") or "") == str(shipment.get("id"))]
    if not lines:
        lines = [product]
    total_quantity = sum(max(0.0, number(p.get("quantity", 1))) for p in lines)
    total_product_net = sum(
        max(0.0, number(p.get("unitNetWeightG"))) * max(0.0, number(p.get("quantity", 1))) / 1000
        for p in lines
    )
    net_weight = max(0.0, number(shipment.get("netWeightKg"))) or total_product_net
    gross_weight = max(0.0, number(shipment.get("grossWeightKg"))) or net_weight
    packaging_weight = max(0.0, gross_weight - net_weight)

    method = shipment.get("distributionMethod") or "weight"
    line_weights = []
    for line in lines:
        line_net = max(0.0, number(line.get("unitNetWeightG"))) * max(0.0, number(line.get("quantity", 1))) / 1000
        allocated_packaging = packaging_weight * line_net / net_weight if net_weight > 0 else 0.0
        line_weights.append((line, line_net + allocated_packaging))
    total_allocated_weight = sum(weight for _, weight in line_weights)

    selected_share = 0.0
    selected_gross = 0.0
    for line, line_gross in line_weights:
        if str(line.get("id")) != str(product.get("id")):
            continue
        selected_gross = line_gross
        if method == "quantity":
            line_qty = max(0.0, number(line.get("quantity", 1)))
            selected_share = line_qty / total_quantity if total_quantity else 0.0
        elif method == "equal":
            selected_share = 1 / len(lines) if lines else 0.0
        else:
            selected_share = line_gross / total_allocated_weight if total_allocated_weight else 0.0
        break

    usd_to_yuan = max(0.0, number(shipment.get("usdToYuanRate")))
    shipment_yuan_to_rub = max(0.0, number(shipment.get("yuanToRubRate")))
    transport_usd = (
        max(0.0, number(shipment.get("autoFreightUsdPerKg"))) * gross_weight
        + max(0.0, number(shipment.get("packagingPerBoxUsd"))) * max(0.0, number(shipment.get("boxCount")))
    )
    transport_total_rub = transport_usd * usd_to_yuan * shipment_yuan_to_rub
    shared_total_rub = sum(max(0.0, number(shipment.get(key))) for key in (
        "deliveryToSpbRub", "deliveryToHomeRub", "loadersRub", "packingRub"
    ))
    purchase_total_rub = (quantity * price_yuan + local_yuan) * purchase_rate
    allocated_transport = transport_total_rub * selected_share
    allocated_shared = shared_total_rub * selected_share
    per_unit = (purchase_total_rub + allocated_transport + allocated_shared) / quantity if quantity else 0.0
    return {
        "costPerUnit": per_unit,
        "purchaseRub": purchase_total_rub,
        "transportRub": allocated_transport,
        "sharedExpensesRub": allocated_shared,
        "allocationShare": selected_share,
        "allocatedGrossWeightKg": selected_gross,
        "shipmentName": shipment.get("name"),
        "source": "shipment",
    }


def calculate_workspace(products: list[dict], shipments: list[dict]) -> dict[str, dict]:
    by_id = {str(s.get("id")): s for s in shipments}
    result = {}
    for product in products:
        shipment = by_id.get(str(product.get("shipmentId") or ""))
        result[str(product.get("id"))] = calculate_product_cost(product, shipment, products)
    return result


def clean_workspace(products: Any, shipments: Any) -> dict:
    if not isinstance(products, list) or not isinstance(shipments, list):
        raise ValueError("Ожидаются списки товаров и поставок.")
    if len(products) > 5000 or len(shipments) > 1000:
        raise ValueError("Слишком много товаров или поставок.")
    clean_shipments = []
    shipment_ids = set()
    for raw in shipments:
        if not isinstance(raw, dict):
            raise ValueError("Некорректная запись поставки.")
        sid = str(raw.get("id") or "").strip()
        name = str(raw.get("name") or "").strip()
        if not sid or len(sid) > 80 or not name or len(name) > 160 or sid in shipment_ids:
            raise ValueError("У каждой поставки должно быть уникальное имя и идентификатор.")
        shipment_ids.add(sid)
        method = str(raw.get("distributionMethod") or "weight")
        if method not in ("weight", "quantity", "equal"):
            raise ValueError("Неизвестный способ распределения расходов.")
        status = str(raw.get("status") or "planned")
        if status not in ("planned", "in_transit", "delivered"):
            raise ValueError("Неизвестный статус поставки.")
        item = dict(raw)
        item.update({"id": sid, "name": name, "status": status, "distributionMethod": method})
        clean_shipments.append(item)

    clean_products = []
    product_ids = set()
    for raw in products:
        if not isinstance(raw, dict):
            raise ValueError("Некорректная запись товара.")
        pid = str(raw.get("id") or "").strip()
        name = str(raw.get("name") or "").strip()
        if not pid or len(pid) > 80 or not name or len(name) > 300 or pid in product_ids:
            raise ValueError("У каждого товара должно быть уникальное имя и идентификатор.")
        product_ids.add(pid)
        shipment_id = str(raw.get("shipmentId") or "")
        if shipment_id and shipment_id not in shipment_ids:
            raise ValueError("Товар ссылается на неизвестную поставку.")
        status = str(raw.get("status") or "selected")
        if status not in ("selected", "archive", "delivered"):
            raise ValueError("Неизвестный статус товара.")
        item = dict(raw)
        item.update({"id": pid, "name": name, "status": status, "shipmentId": shipment_id})
        item.setdefault("sku", "")
        item.setdefault("yuan", 0)
        item.setdefault("rate", 12)
        item.setdefault("freight", 0)
        item.setdefault("quantity", 1)
        item.setdefault("unitNetWeightG", 0)
        item.setdefault("deliveryToGuangzhouYuan", 0)
        clean_products.append(item)
    return {"products": clean_products, "shipments": clean_shipments}


def _date_value(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if value is None or value == "":
        return ""
    return str(value)[:10]


def parse_legacy_xlsx(raw: bytes) -> dict:
    """Import the user's legacy 'Китай' sheet; formulas are recomputed from inputs."""
    try:
        workbook = load_workbook(BytesIO(raw), data_only=True, read_only=True)
    except Exception as exc:
        raise ValueError("Не удалось открыть Excel-файл. Проверьте формат .xlsx.") from exc
    if not workbook.worksheets:
        raise ValueError("В книге нет листов.")
    sheet = workbook["Китай"] if "Китай" in workbook.sheetnames else workbook.worksheets[0]
    headers = [str(cell.value or "").strip() for cell in sheet[1]]
    if len(headers) < 30 or headers[3] != "Наименование товара" or headers[13] != "Поставка":
        raise ValueError("Не найден ожидаемый формат таблицы «Китай».")

    groups: dict[str, list[tuple[int, tuple]]] = {}
    for row_number, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
        if len(row) < 30 or not str(row[3] or "").strip():
            continue
        shipment_name = str(row[13] or row[2] or "Поставка без названия").strip()
        groups.setdefault(shipment_name, []).append((row_number, row))
    if not groups:
        raise ValueError("В Excel не найдены строки с товарами.")

    products, shipments = [], []
    for shipment_name, rows in groups.items():
        shipment_id = uuid.uuid5(uuid.NAMESPACE_URL, "isk-cost-shipment:" + shipment_name).hex
        first = rows[0][1]

        def first_number(index: int) -> float:
            for _, row in rows:
                value = number(row[index])
                if value:
                    return value
            return 0.0

        departure = next((_date_value(r[0]) for _, r in rows if r[0]), "")
        arrival = next((_date_value(r[1]) for _, r in rows if r[1]), "")
        status = "delivered" if arrival and arrival <= date.today().isoformat() else ("in_transit" if departure else "planned")
        shipment = {
            "id": shipment_id,
            "name": shipment_name,
            "departureDate": departure,
            "arrivalDate": arrival,
            "status": status,
            "packagingPerBoxUsd": first_number(14),
            "autoFreightUsdPerKg": first_number(15),
            "netWeightKg": first_number(16),
            "grossWeightKg": first_number(17),
            "boxCount": first_number(18),
            "usdToYuanRate": first_number(21),
            "yuanToRubRate": first_number(22),
            "deliveryToSpbRub": first_number(24),
            "deliveryToHomeRub": first_number(25),
            "loadersRub": first_number(26),
            "packingRub": first_number(28),
            "distributionMethod": "weight",
        }
        shipments.append(shipment)
        for row_number, row in rows:
            sku = str(row[2] or "").strip()
            name = str(row[3] or "").strip()
            product_id = uuid.uuid5(
                uuid.NAMESPACE_URL, f"isk-cost-product:{shipment_name}:{sku}:{name}:{row_number}"
            ).hex
            products.append({
                "id": product_id,
                "sku": sku,
                "name": name,
                "unitNetWeightG": number(row[4]),
                "yuan": number(row[5]),
                "quantity": number(row[6]),
                "deliveryToGuangzhouYuan": number(row[7]),
                "rate": number(row[10]),
                "freight": 0,
                "shipmentId": shipment_id,
                "status": "delivered" if status == "delivered" else "selected",
            })
    workspace = clean_workspace(products, shipments)
    return {
        **workspace,
        "importedProducts": len(products),
        "importedShipments": len(shipments),
    }
