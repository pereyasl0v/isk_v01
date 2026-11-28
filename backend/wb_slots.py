"""Monitor official warehouse acceptance tariffs for selected FBW dates."""
import logging
import threading
from datetime import date, datetime, timedelta, timezone

from cryptography.exceptions import InvalidTag
from pydantic import BaseModel, Field

from .ozon import MOSCOW_TZ
from .security import decrypt_wb_token
from .wildberries import Wildberries, WildberriesApiError


CHECK_INTERVAL = 60
HORIZON_DAYS = 14
# Fixed stripes coordinate scheduled checks and form requests per cabinet.
_CACHE_LOCKS = [threading.Lock() for _ in range(16)]


class SlotWatch(BaseModel):
    date: date
    warehouse_id: int = Field(gt=0)
    box_type_id: int = Field(gt=0)


class SlotWatchRemoval(BaseModel):
    id: int = Field(gt=0)


def tariff_snapshot(store, account, api_key):
    account_id = account['id']
    scope = 'wb:' + account_id
    revision = account['updated_at']
    with _CACHE_LOCKS[hash(account_id) % len(_CACHE_LOCKS)]:
        cached = store.cache_get(scope, 'acceptance', revision, CHECK_INTERVAL)
        if cached is not None:
            return cached
        try:
            token = decrypt_wb_token(account['api_token_ciphertext'], api_key)
        except (InvalidTag, ValueError, TypeError):
            result = {'error': 'Не удалось прочитать токен WB. Обновите токен кабинета.'}
        else:
            try:
                result = {'rows': Wildberries(token).acceptance_coefficients()}
            except WildberriesApiError as exc:
                result = {'error': str(exc)}
        store.cache_put(scope, 'acceptance', revision, result)
        return result


def box_options(snapshot):
    options = {}
    for row in snapshot.get('rows', []):
        if not isinstance(row, dict):
            continue
        warehouse_id, box_type_id = row.get('warehouseID'), row.get('boxTypeID')
        if type(warehouse_id) is not int or warehouse_id <= 0:
            continue
        if type(box_type_id) is not int or box_type_id <= 0:
            continue
        options[warehouse_id, box_type_id] = {
            'warehouse_id': warehouse_id,
            'warehouse_name': str(row.get('warehouseName') or warehouse_id),
            'box_type_id': box_type_id,
            'box_type_name': str(row.get('boxTypeName') or box_type_id),
        }
    return options


def add_watch(store, account_id, watch, option):
    with store.db() as conn:
        conn.execute('''INSERT INTO wb_slot_watches(account_id,target_date,warehouse_id,warehouse_name,
                          box_type_id,box_type_name) VALUES(?,?,?,?,?,?)
                        ON CONFLICT(account_id,target_date,warehouse_id,box_type_id) DO NOTHING''',
                     (account_id, watch.date.isoformat(), watch.warehouse_id, option['warehouse_name'],
                      watch.box_type_id, option['box_type_name']))


def list_watches(store, account_id, today):
    with store.db() as conn:
        rows = conn.execute('''SELECT id,target_date,warehouse_name,box_type_name,checked_at,found_at,coefficient,error
                               FROM wb_slot_watches WHERE account_id=? ORDER BY target_date,id DESC''',
                            (account_id,)).fetchall()
    keys = ('id', 'date', 'warehouse_name', 'box_type_name', 'checked_at', 'found_at', 'coefficient', 'error')
    horizon = (today + timedelta(days=HORIZON_DAYS - 1)).isoformat()
    result = []
    for row in rows:
        item = dict(zip(keys, row))
        if item['found_at']:
            status = 'found'
        elif item['date'] < today.isoformat():
            status = 'expired'
        elif item['date'] > horizon:
            status = 'outside_window'
        elif item['error']:
            status = 'error'
        else:
            status = 'waiting'
        result.append({**item, 'status': status})
    return result


def remove_watch(store, account_id, watch_id):
    with store.db() as conn:
        return bool(conn.execute('DELETE FROM wb_slot_watches WHERE account_id=? AND id=?',
                                 (account_id, watch_id)).rowcount)


def check_watches(store, api_key, now):
    today = now.astimezone(MOSCOW_TZ).date()
    end = today + timedelta(days=HORIZON_DAYS - 1)
    at = now.astimezone(timezone.utc).isoformat()
    threshold = (now.astimezone(timezone.utc) - timedelta(seconds=CHECK_INTERVAL)).isoformat()
    with store.db() as conn:
        due = conn.execute('''SELECT DISTINCT a.id,a.user_id FROM wb_slot_watches w
            JOIN wb_accounts a ON a.id=w.account_id JOIN users u ON u.id=a.user_id
            WHERE a.connected=1 AND u.is_active=1 AND w.found_at IS NULL AND w.target_date BETWEEN ? AND ?
            AND (w.checked_at IS NULL OR w.checked_at<=?)''',
            (today.isoformat(), end.isoformat(), threshold)).fetchall()
    for account_id, user_id in due:
        account = store.get_wb_account(account_id, user_id)
        if not account or not account['connected']:
            continue
        snapshot = tariff_snapshot(store, account, api_key)
        available = {}
        for row in snapshot.get('rows', []):
            if not isinstance(row, dict):
                continue
            coefficient = row.get('coefficient')
            if type(coefficient) is not int or coefficient < 0 or row.get('allowUnload') is not True:
                continue
            day = str(row.get('date') or '')[:10]
            warehouse_id, box_type_id = row.get('warehouseID'), row.get('boxTypeID')
            if type(warehouse_id) is int and type(box_type_id) is int:
                key = (day, warehouse_id, box_type_id)
                available[key] = min(available.get(key, coefficient), coefficient)
        with store.db() as conn:
            watches = conn.execute('''SELECT id,target_date,warehouse_id,box_type_id FROM wb_slot_watches
                WHERE account_id=? AND found_at IS NULL AND target_date BETWEEN ? AND ?
                AND (checked_at IS NULL OR checked_at<=?)''',
                (account_id, today.isoformat(), end.isoformat(), threshold)).fetchall()
            for watch_id, day, warehouse_id, box_type_id in watches:
                coefficient = available.get((day, warehouse_id, box_type_id))
                conn.execute('''UPDATE wb_slot_watches SET checked_at=?,found_at=?,coefficient=?,error=?
                    WHERE id=? AND found_at IS NULL AND EXISTS (SELECT 1 FROM wb_accounts
                        WHERE id=? AND connected=1 AND updated_at=?)''',
                    (at, at if coefficient is not None else None, coefficient, snapshot.get('error'),
                     watch_id, account_id, account['updated_at']))


def run_schedule(get_store, api_key, stop):
    while api_key and not stop.is_set():
        try:
            check_watches(get_store(), api_key, datetime.now(timezone.utc))
        except Exception:
            logging.getLogger(__name__).exception('Ошибка проверки приёмки WB')
        stop.wait(CHECK_INTERVAL)
