"""Shared rule for Ozon orders: last N completed Moscow calendar days.

The inclusive end date is always yesterday in Europe/Moscow, matching the
Digitization presets. Today's in-progress figures must not enter the chart.
"""
from datetime import datetime, timedelta
from .ozon import MOSCOW_TZ


def closed_sales_period(days, now=None):
    if not isinstance(days, int) or isinstance(days, bool) or days < 1 or days > 90:
        raise ValueError('Период заказов должен быть от 1 до 90 дней.')
    instant = now if now is not None else datetime.now(MOSCOW_TZ)
    if instant.tzinfo is None:
        raise ValueError('Для расчёта периода нужна дата с часовым поясом.')
    last_closed = instant.astimezone(MOSCOW_TZ).date() - timedelta(days=1)
    return last_closed - timedelta(days=days - 1), last_closed
