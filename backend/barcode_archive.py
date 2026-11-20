"""Private, user-scoped archive for printable barcode labels."""
import re

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

router = APIRouter()

FIELD_KEYS = {
    "productName", "article", "brand", "color", "size", "completeness",
    "material", "shelfLife", "additionalInfo", "importer", "importerInn",
    "importerAddress", "country", "manufacturer", "manufacturerAddress",
    "manufacturingDate",
}
SIZE_KEYS = {"58x40", "60x30", "60x40", "70x30"}


class BarcodeLabelBody(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    code: str = Field(default="", max_length=13)
    data: dict = Field(default_factory=dict)


def _check_digit(first_twelve: str) -> str:
    total = sum(
        int(digit) * (1 if index % 2 == 0 else 3)
        for index, digit in enumerate(first_twelve)
    )
    return str((10 - total % 10) % 10)


def _clean(body: BarcodeLabelBody):
    values = body.data.get("values")
    if not isinstance(values, dict):
        raise HTTPException(422, "Не удалось прочитать данные этикетки.")

    clean_values = {}
    for key in FIELD_KEYS:
        value = values.get(key, "")
        if value is None:
            value = ""
        if not isinstance(value, (str, int, float)):
            raise HTTPException(422, "Проверьте текстовые поля этикетки.")
        clean_values[key] = str(value).strip()[:3000]

    name = clean_values["productName"] or body.name.strip()
    if not name:
        raise HTTPException(422, "Укажите наименование товара.")
    name = name[:300]
    clean_values["productName"] = name

    enabled_input = body.data.get("enabled", {})
    if not isinstance(enabled_input, dict):
        raise HTTPException(422, "Проверьте настройки полей этикетки.")
    enabled = {key: bool(enabled_input.get(key, False)) for key in FIELD_KEYS}

    barcode_enabled = body.data.get("barcodeEnabled", True)
    if not isinstance(barcode_enabled, bool):
        raise HTTPException(422, "Проверьте настройку печати штрихкода.")

    code = re.sub(r"\D", "", body.code)
    if barcode_enabled:
        if len(code) != 13 or code[-1] != _check_digit(code[:12]):
            raise HTTPException(422, "Укажите корректный код EAN-13.")
    else:
        code = ""

    size_key = body.data.get("sizeKey", "58x40")
    if size_key not in SIZE_KEYS:
        raise HTTPException(422, "Недопустимый размер этикетки.")

    try:
        text_size = float(body.data.get("textSize", 1.76))
    except (TypeError, ValueError):
        raise HTTPException(422, "Проверьте размер текста.") from None
    if not 0.85 <= text_size <= 2.4:
        raise HTTPException(422, "Размер текста должен быть от 0,85 до 2,4 мм.")

    cleaned = {
        "values": clean_values,
        "enabled": enabled,
        "code": code,
        "barcodeEnabled": barcode_enabled,
        "sizeKey": size_key,
        "textSize": text_size,
        "showEac": bool(body.data.get("showEac", False)),
        "showRst": bool(body.data.get("showRst", False)),
    }
    return name, code, cleaned


def _auth(request: Request):
    from . import main

    return main.authenticated(request)


@router.get("/api/barcodes")
def list_barcodes(request: Request, q: str = Query(default="", max_length=100)):
    from . import main

    auth = _auth(request)
    return {"items": main.store.list_barcode_labels(auth["user_id"], q)}


def _record_or_404(user_id: str, label_id: str):
    from . import main

    record = main.store.get_barcode_label(user_id, label_id)
    if not record:
        raise HTTPException(404, "Этикетка не найдена в архиве.")
    return record


@router.get("/api/barcodes/{label_id}")
def get_barcode(label_id: str, request: Request):
    auth = _auth(request)
    return _record_or_404(auth["user_id"], label_id)


@router.post("/api/barcodes", status_code=201)
def create_barcode(body: BarcodeLabelBody, request: Request):
    from . import main

    auth = _auth(request)
    name, code, data = _clean(body)
    return main.store.save_barcode_label(auth["user_id"], None, name, code, data)


@router.put("/api/barcodes/{label_id}")
def update_barcode(label_id: str, body: BarcodeLabelBody, request: Request):
    from . import main

    auth = _auth(request)
    name, code, data = _clean(body)
    saved = main.store.save_barcode_label(auth["user_id"], label_id, name, code, data)
    if not saved:
        raise HTTPException(404, "Этикетка не найдена в архиве.")
    return saved


@router.delete("/api/barcodes/{label_id}")
def delete_barcode(label_id: str, request: Request):
    from . import main

    auth = _auth(request)
    if not main.store.delete_barcode_label(auth["user_id"], label_id):
        raise HTTPException(404, "Этикетка не найдена в архиве.")
    return {"ok": True}
