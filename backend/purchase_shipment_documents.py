"""Encrypted attachments belonging to purchase shipments."""
import re
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import quote, unquote

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, HTTPException, Request, Response

MAX_FILE_SIZE = 15 * 1024 * 1024
MAX_FILES_PER_SHIPMENT = 40
ALLOWED_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".rtf",
    ".xml", ".odt", ".ods", ".jpg", ".jpeg", ".png", ".webp", ".zip",
}

router = APIRouter()


def _scope(request: Request, shipment_id: str):
    from . import main

    if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", shipment_id):
        raise HTTPException(404, "Поставка не найдена.")
    auth = main.authenticated(request)
    user_id = str(auth["user_id"])
    if not main.store.get_purchase_shipment(user_id, shipment_id):
        raise HTTPException(404, "Поставка не найдена.")
    return user_id


def _aad(user_id: str, shipment_id: str, document_id: str):
    return (
        "isk-purchase-shipment-document-v1:"
        + user_id + ":" + shipment_id + ":" + document_id
    ).encode("utf-8")


def _encrypt_file(raw: bytes, key: bytes, user_id: str, shipment_id: str, document_id: str):
    if not key:
        raise HTTPException(503, "Ключ шифрования недоступен.")
    nonce = secrets.token_bytes(12)
    return nonce + AESGCM(key).encrypt(
        nonce, raw, _aad(user_id, shipment_id, document_id)
    )


def _decrypt_file(encrypted: bytes, key: bytes, user_id: str, shipment_id: str, document_id: str):
    if not key:
        raise HTTPException(503, "Ключ шифрования недоступен.")
    return AESGCM(key).decrypt(
        encrypted[:12], encrypted[12:], _aad(user_id, shipment_id, document_id)
    )


def _filename(request: Request):
    try:
        name = unquote(
            request.headers.get("X-File-Name", ""),
            encoding="utf-8",
            errors="strict",
        )
    except UnicodeError:
        raise HTTPException(422, "Некорректное имя файла.") from None
    name = name.replace("\\", "/").split("/")[-1].strip()
    if (
        not name
        or len(name) > 180
        or any(ord(ch) < 32 for ch in name)
        or PurePosixPath(name).suffix.lower() not in ALLOWED_EXTENSIONS
    ):
        raise HTTPException(
            422,
            "Разрешены PDF, Office, изображения, текстовые документы и ZIP "
            "(имя до 180 символов).",
        )
    return name


def _document_dict(row):
    return {"id": row[0], "name": row[1], "size": row[2], "added_at": row[3]}


@router.get("/api/purchase-shipments/{shipment_id}/documents")
def list_purchase_shipment_documents(shipment_id: str, request: Request):
    user_id = _scope(request, shipment_id)
    from . import main

    with main.store.db() as db:
        rows = db.execute(
            """SELECT id,filename,byte_size,added_at
               FROM purchase_shipment_documents
               WHERE user_id=? AND shipment_id=?
               ORDER BY added_at DESC,id DESC""",
            (user_id, shipment_id),
        ).fetchall()
    return {"documents": [_document_dict(row) for row in rows]}


@router.post("/api/purchase-shipments/{shipment_id}/documents", status_code=201)
async def upload_purchase_shipment_document(shipment_id: str, request: Request):
    user_id = _scope(request, shipment_id)
    name = _filename(request)
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/octet-stream":
        raise HTTPException(415, "Ожидался файл в бинарном формате.")
    try:
        content_length = int(request.headers.get("content-length") or "0")
    except ValueError:
        raise HTTPException(400, "Некорректный размер файла.") from None
    if content_length > MAX_FILE_SIZE:
        raise HTTPException(413, "Максимальный размер файла — 15 МБ.")

    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > MAX_FILE_SIZE:
            raise HTTPException(413, "Максимальный размер файла — 15 МБ.")
        content.extend(chunk)
    if not content:
        raise HTTPException(422, "Нельзя загрузить пустой файл.")

    from . import main

    document_id = uuid.uuid4().hex
    encrypted = _encrypt_file(
        bytes(content), main.store.encryption_key, user_id, shipment_id, document_id
    )
    created = datetime.now(timezone.utc).isoformat()
    with main.store.db() as db:
        count = db.execute(
            """SELECT COUNT(*) FROM purchase_shipment_documents
               WHERE user_id=? AND shipment_id=?""",
            (user_id, shipment_id),
        ).fetchone()[0]
        if count >= MAX_FILES_PER_SHIPMENT:
            raise HTTPException(409, "На одну поставку можно прикрепить максимум 40 файлов.")
        db.execute(
            """INSERT INTO purchase_shipment_documents
               (id,user_id,shipment_id,filename,byte_size,added_at,ciphertext)
               VALUES(?,?,?,?,?,?,?)""",
            (document_id, user_id, shipment_id, name, len(content), created, encrypted),
        )
    return {"id": document_id, "name": name, "size": len(content), "added_at": created}


@router.get("/api/purchase-shipments/{shipment_id}/documents/{document_id}")
def download_purchase_shipment_document(shipment_id: str, document_id: str, request: Request):
    user_id = _scope(request, shipment_id)
    from . import main

    with main.store.db() as db:
        row = db.execute(
            """SELECT filename,ciphertext FROM purchase_shipment_documents
               WHERE id=? AND user_id=? AND shipment_id=?""",
            (document_id, user_id, shipment_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Файл не найден.")
    try:
        raw = _decrypt_file(
            row[1], main.store.encryption_key, user_id, shipment_id, document_id
        )
    except (ValueError, TypeError):
        raise HTTPException(500, "Не удалось расшифровать файл.") from None
    return Response(
        content=raw,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": "attachment; filename*=UTF-8''" + quote(row[0], safe="")
        },
    )


@router.delete("/api/purchase-shipments/{shipment_id}/documents/{document_id}")
def delete_purchase_shipment_document(shipment_id: str, document_id: str, request: Request):
    user_id = _scope(request, shipment_id)
    from . import main

    with main.store.db() as db:
        result = db.execute(
            """DELETE FROM purchase_shipment_documents
               WHERE id=? AND user_id=? AND shipment_id=?""",
            (document_id, user_id, shipment_id),
        )
        if result.rowcount == 0:
            raise HTTPException(404, "Файл не найден.")
    return {"deleted": True}
