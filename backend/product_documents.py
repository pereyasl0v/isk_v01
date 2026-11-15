"""Account-scoped descriptions and encrypted certification files for Ozon products."""
import re
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import quote, unquote

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

MAX_FILE_SIZE = 15 * 1024 * 1024
MAX_FILES_PER_PRODUCT = 40
ALLOWED_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".rtf",
    ".xml", ".odt", ".ods", ".jpg", ".jpeg", ".png", ".webp", ".zip",
}

router = APIRouter()


class ProductNote(BaseModel):
    description: str = Field(max_length=4000)


def _store():
    # Import dynamically so tests and admin migrations can replace main.store.
    from . import main
    return main.store


def _scope(request: Request, product_id: str):
    from . import main

    if not re.fullmatch(r"\d{1,30}", product_id):
        raise HTTPException(404, "Товар не найден.")
    scope = main.current(request)["client"]
    inventory = main.store.latest(scope, "inventory") or {}
    if not any(str(product.get("id")) == product_id for product in inventory.get("products", [])):
        raise HTTPException(404, "Товар не найден в текущем кабинете.")
    return scope


def _aad(scope: str, product_id: str, document_id: str):
    return ("isk-product-document-v1:" + scope + ":" + product_id + ":" + document_id).encode("utf-8")


def _encrypt_file(raw: bytes, key: bytes, scope: str, product_id: str, document_id: str):
    if not key:
        raise HTTPException(503, "Ключ шифрования недоступен.")
    nonce = secrets.token_bytes(12)
    return nonce + AESGCM(key).encrypt(nonce, raw, _aad(scope, product_id, document_id))


def _decrypt_file(encrypted: bytes, key: bytes, scope: str, product_id: str, document_id: str):
    if not key:
        raise HTTPException(503, "Ключ шифрования недоступен.")
    return AESGCM(key).decrypt(encrypted[:12], encrypted[12:], _aad(scope, product_id, document_id))


def _filename(request: Request):
    raw = request.headers.get("X-File-Name", "")
    try:
        name = unquote(raw, encoding="utf-8", errors="strict")
    except UnicodeError:
        raise HTTPException(422, "Некорректное имя файла.") from None
    name = name.replace("\\", "/").split("/")[-1].strip()
    if (not name or len(name) > 180 or any(ord(ch) < 32 for ch in name)
            or PurePosixPath(name).suffix.lower() not in ALLOWED_EXTENSIONS):
        raise HTTPException(422, "Разрешены PDF, Office, изображения, текстовые документы и ZIP (имя до 180 символов).")
    return name


def _document_dict(row):
    return {"id": row[0], "name": row[1], "size": row[2], "added_at": row[3]}


@router.get("/api/products/{product_id}/details")
def get_product_details(product_id: str, request: Request):
    scope = _scope(request, product_id)
    store = _store()
    with store.db() as db:
        row = db.execute(
            "SELECT payload FROM product_notes WHERE client=? AND product_id=?",
            (scope, product_id),
        ).fetchone()
        attachments = db.execute(
            """SELECT id,filename,byte_size,added_at FROM product_documents
               WHERE client=? AND product_id=? ORDER BY added_at DESC,id DESC""",
            (scope, product_id),
        ).fetchall()
    description = store._decode_payload(row[0]).get("description", "") if row else ""
    return {"description": description, "documents": [_document_dict(item) for item in attachments]}


@router.put("/api/products/{product_id}/details")
def save_product_details(product_id: str, body: ProductNote, request: Request):
    scope = _scope(request, product_id)
    store = _store()
    now = datetime.now(timezone.utc).isoformat()
    payload = store._encode_payload({"description": body.description})
    with store.db() as db:
        db.execute(
            """INSERT INTO product_notes(client,product_id,payload,updated_at)
               VALUES(?,?,?,?) ON CONFLICT(client,product_id)
               DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at""",
            (scope, product_id, payload, now),
        )
    return {"description": body.description, "saved": True}


@router.post("/api/products/{product_id}/documents", status_code=201)
async def upload_product_document(product_id: str, request: Request):
    scope = _scope(request, product_id)
    name = _filename(request)
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/octet-stream":
        raise HTTPException(415, "Ожидался файл в бинарном формате.")
    if int(request.headers.get("content-length") or "0") > MAX_FILE_SIZE:
        raise HTTPException(413, "Максимальный размер файла — 15 МБ.")

    # Enforce the limit during streaming even if Content-Length is missing/forged.
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > MAX_FILE_SIZE:
            raise HTTPException(413, "Максимальный размер файла — 15 МБ.")
        content.extend(chunk)
    if not content:
        raise HTTPException(422, "Нельзя загрузить пустой файл.")

    store = _store()
    document_id = uuid.uuid4().hex
    encrypted = _encrypt_file(bytes(content), store.encryption_key, scope, product_id, document_id)
    created = datetime.now(timezone.utc).isoformat()
    with store.db() as db:
        count = db.execute(
            "SELECT COUNT(*) FROM product_documents WHERE client=? AND product_id=?",
            (scope, product_id),
        ).fetchone()[0]
        if count >= MAX_FILES_PER_PRODUCT:
            raise HTTPException(409, "На один товар можно прикрепить максимум 40 файлов.")
        db.execute(
            """INSERT INTO product_documents(id,client,product_id,filename,byte_size,added_at,ciphertext)
               VALUES(?,?,?,?,?,?,?)""",
            (document_id, scope, product_id, name, len(content), created, encrypted),
        )
    return {"id": document_id, "name": name, "size": len(content), "added_at": created}


@router.get("/api/products/{product_id}/documents/{document_id}")
def download_product_document(product_id: str, document_id: str, request: Request):
    scope = _scope(request, product_id)
    store = _store()
    with store.db() as db:
        row = db.execute(
            """SELECT filename,ciphertext FROM product_documents
               WHERE id=? AND client=? AND product_id=?""",
            (document_id, scope, product_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Файл не найден.")
    try:
        raw = _decrypt_file(row[1], store.encryption_key, scope, product_id, document_id)
    except (ValueError, TypeError):
        raise HTTPException(500, "Не удалось расшифровать файл.") from None
    return Response(
        content=raw,
        media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(row[0], safe="")},
    )


@router.delete("/api/products/{product_id}/documents/{document_id}")
def delete_product_document(product_id: str, document_id: str, request: Request):
    scope = _scope(request, product_id)
    store = _store()
    with store.db() as db:
        result = db.execute(
            "DELETE FROM product_documents WHERE id=? AND client=? AND product_id=?",
            (document_id, scope, product_id),
        )
        if result.rowcount == 0:
            raise HTTPException(404, "Файл не найден.")
    return {"deleted": True}
