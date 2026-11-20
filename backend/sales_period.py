"""Reporting ranges in Europe/Moscow for Ozon analytics.

Digitization works with N completed days, ending yesterday.
The order chart adds the ongoing current day to that same N-day range.
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


def sales_chart_period(days, now=None):
    """Inclusive N closed Moscow days plus the current day (N+1 data points)."""
    first, last_closed = closed_sales_period(days, now)
    return first, last_closed + timedelta(days=1)
