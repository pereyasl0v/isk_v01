"""One-time, read-only import of the legacy Windows Ozon SQLite database.

Run inside the application container after copying a SQLite backup to /tmp:
python -m backend.import_legacy --source /tmp/legacy.sqlite3 --username admin
"""
import argparse
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from .security import load_encryption_key
from .storage import Store

TABLE_COLUMNS = {
    "snapshots": {"client", "kind", "at", "payload"},
    "api_cache": {"client", "namespace", "cache_key", "updated_at", "payload"},
    "digitization_periods": {"client", "date_from", "date_to", "updated_at", "payload"},
    "digitization_days": {"client", "day", "updated_at", "payload"},
}


class LegacyImportError(RuntimeError):
    pass


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _open_readonly(path):
    # The supplied file should be a standalone SQLite backup (created with
    # sqlite3.Connection.backup), so immutable mode cannot miss a WAL file.
    uri = "file:" + quote(str(path), safe="/") + "?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True, timeout=10)
    connection.execute("PRAGMA query_only=ON")
    return connection


def _encode_legacy_payload(store, raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    if not isinstance(raw, str):
        raise LegacyImportError("В старой базе обнаружен payload не в текстовом формате.")
    try:
        if raw.startswith("enc:v1:"):
            value = store._decode_payload(raw)
        else:
            value = json.loads(raw)
        return store._encode_payload(value)
    except Exception as exc:
        raise LegacyImportError(
            "Не удалось прочитать один из payload старой базы. "
            "Импорт отменён без частичной записи."
        ) from exc


def import_legacy_database(source_path, store, username):
    """Import all legacy Ozon data into the selected admin's matching account.

    The import is atomic and idempotent per account. The source database is
    opened read-only and is never modified.
    """
    source_path = Path(source_path).expanduser().resolve()
    if not source_path.is_file():
        raise LegacyImportError(f"Файл старой базы не найден: {source_path}")
    if not store.encryption_key:
        raise LegacyImportError("Не настроен ключ шифрования ИСК.")

    user = store.get_user_by_username(username)
    if not user or not user["is_active"]:
        raise LegacyImportError("Активный пользователь с таким логином не найден.")
    if user["role"] != "admin":
        raise LegacyImportError("Перенос старой базы разрешён только администратору.")

    source_hash = _sha256(source_path)
    source = _open_readonly(source_path)
    try:
        tables = {
            row[0] for row in source.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        missing = sorted(set(TABLE_COLUMNS) - tables)
        if missing:
            raise LegacyImportError(
                "В резервной копии отсутствуют таблицы: " + ", ".join(missing)
            )

        for table, expected in TABLE_COLUMNS.items():
            columns = {
                row[1] for row in source.execute(f'PRAGMA table_info("{table}")')
            }
            if not expected.issubset(columns):
                raise LegacyImportError(f"Неожиданная структура таблицы {table}.")

        client_ids = set()
        source_counts = {}
        for table in TABLE_COLUMNS:
            ids = {
                str(row[0]) for row in source.execute(
                    f'SELECT DISTINCT client FROM "{table}" WHERE client IS NOT NULL'
                )
            }
            client_ids.update(ids)
            source_counts[table] = int(
                source.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            )
        if len(client_ids) != 1:
            raise LegacyImportError(
                "В старой базе найдено несколько Client ID или нет данных. "
                "Автоматический перенос остановлен, чтобы не смешать кабинеты."
            )
        source_client_id = next(iter(client_ids))

        with store.db() as target:
            accounts = target.execute(
                """SELECT id, client_id, connected FROM ozon_accounts
                   WHERE user_id=? AND client_id=?""",
                (user["id"], source_client_id),
            ).fetchall()
            if len(accounts) != 1:
                raise LegacyImportError(
                    "У выбранного администратора не найден ровно один кабинет "
                    f"Ozon с Client ID {source_client_id}."
                )
            account_id, account_client_id, connected = accounts[0]
            if not connected:
                raise LegacyImportError(
                    "Подходящий кабинет Ozon отключён. Сначала подключите его в ИСК."
                )

            existing = target.execute(
                """SELECT source_sha256, counts_json FROM legacy_database_imports
                   WHERE account_id=?""",
                (account_id,),
            ).fetchone()
            if existing:
                if existing[0] == source_hash:
                    return {
                        "status": "already_imported",
                        "source_client_id": source_client_id,
                        "account_id": account_id,
                        "counts": json.loads(existing[1]),
                    }
                raise LegacyImportError(
                    "Для этого кабинета уже импортирована другая резервная копия. "
                    "Повторный импорт остановлен, чтобы не создавать дубликаты."
                )

            reused = target.execute(
                "SELECT account_id FROM legacy_database_imports WHERE source_sha256=?",
                (source_hash,),
            ).fetchone()
            if reused:
                raise LegacyImportError(
                    "Эта резервная копия уже импортирована в другой кабинет."
                )

            scope = "account:" + account_id

            for row in source.execute(
                "SELECT kind, at, payload FROM snapshots WHERE client=? ORDER BY at ASC, id ASC",
                (source_client_id,),
            ):
                kind, at, payload = row
                encoded = _encode_legacy_payload(store, payload)
                target.execute(
                    "INSERT INTO snapshots(client,kind,at,payload) VALUES (?,?,?,?)",
                    (scope, str(kind), str(at), encoded),
                )

            for row in source.execute(
                """SELECT namespace, cache_key, updated_at, payload
                   FROM api_cache WHERE client=?""",
                (source_client_id,),
            ):
                namespace, cache_key, updated_at, payload = row
                encoded = _encode_legacy_payload(store, payload)
                target.execute(
                    """INSERT INTO api_cache(client,namespace,cache_key,updated_at,payload)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(client,namespace,cache_key) DO UPDATE SET
                         updated_at=excluded.updated_at,payload=excluded.payload
                       WHERE excluded.updated_at > api_cache.updated_at""",
                    (scope, str(namespace), str(cache_key), float(updated_at), encoded),
                )

            for row in source.execute(
                """SELECT date_from,date_to,updated_at,payload
                   FROM digitization_periods WHERE client=?""",
                (source_client_id,),
            ):
                date_from, date_to, updated_at, payload = row
                encoded = _encode_legacy_payload(store, payload)
                target.execute(
                    """INSERT INTO digitization_periods(client,date_from,date_to,updated_at,payload)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(client,date_from,date_to) DO UPDATE SET
                         updated_at=excluded.updated_at,payload=excluded.payload
                       WHERE excluded.updated_at > digitization_periods.updated_at""",
                    (scope, str(date_from), str(date_to), str(updated_at), encoded),
                )

            for row in source.execute(
                """SELECT day,updated_at,payload
                   FROM digitization_days WHERE client=?""",
                (source_client_id,),
            ):
                day, updated_at, payload = row
                encoded = _encode_legacy_payload(store, payload)
                target.execute(
                    """INSERT INTO digitization_days(client,day,updated_at,payload)
                       VALUES (?,?,?,?)
                       ON CONFLICT(client,day) DO UPDATE SET
                         updated_at=excluded.updated_at,payload=excluded.payload
                       WHERE excluded.updated_at > digitization_days.updated_at""",
                    (scope, str(day), str(updated_at), encoded),
                )

            target.execute(
                """INSERT INTO legacy_database_imports
                   (account_id,source_client_id,source_sha256,imported_at,counts_json)
                   VALUES (?,?,?,?,?)""",
                (
                    account_id,
                    account_client_id,
                    source_hash,
                    datetime.now(timezone.utc).isoformat(),
                    json.dumps(source_counts, ensure_ascii=False, sort_keys=True),
                ),
            )

            target_counts = {}
            for table in TABLE_COLUMNS:
                target_counts[table] = int(
                    target.execute(
                        f'SELECT COUNT(*) FROM "{table}" WHERE client=?',
                        (scope,),
                    ).fetchone()[0]
                )

        return {
            "status": "imported",
            "source_client_id": source_client_id,
            "account_id": account_id,
            "source_sha256": source_hash,
            "imported_rows": source_counts,
            "target_rows_after_import": target_counts,
        }
    finally:
        source.close()


def main():
    parser = argparse.ArgumentParser(
        description="Однократный безопасный перенос старой базы Ozon в ИСК"
    )
    parser.add_argument("--source", required=True, help="Путь к резервной копии старой SQLite")
    parser.add_argument("--username", required=True, help="Логин администратора-владельца кабинета")
    args = parser.parse_args()

    data = Path(
        os.environ.get(
            "OZON_FBO_DATA_DIR",
            str(Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "VKR_Ozon_FBO_Web"),
        )
    )
    key = load_encryption_key()
    if not key:
        raise SystemExit("Не найден ключ шифрования. Импорт остановлен.")
    store = Store(data / "inventory.sqlite3", encryption_key=key)
    try:
        result = import_legacy_database(args.source, store, args.username)
    except (LegacyImportError, sqlite3.Error, OSError) as exc:
        raise SystemExit("Импорт не выполнен: " + str(exc)) from None

    print("Статус:", result["status"])
    print("Client ID:", result["source_client_id"])
    print("Кабинет:", result["account_id"])
    if result["status"] == "imported":
        print("SHA-256 резервной копии:", result["source_sha256"])
        print("Перенесено строк:", json.dumps(result["imported_rows"], ensure_ascii=False))
        print("Всего строк в кабинете после импорта:", json.dumps(
            result["target_rows_after_import"], ensure_ascii=False
        ))
    else:
        print("Эта резервная копия уже была импортирована ранее. Повторных записей не создано.")


if __name__ == "__main__":
    main()
