import unittest

from backend.ozon import Ozon
from backend.legacy import ApiError


def analytics_row(day, metrics):
    return {
        'dimensions': [{'id': day, 'name': day}],
        'metrics': metrics,
    }


class DailySalesAnalyticsTests(unittest.TestCase):
    def test_daily_ordered_and_delivered_units_are_grouped_by_day(self):
        calls = []

        def transport(path, payload):
            calls.append((path, payload))
            self.assertEqual(path, '/v1/analytics/data')
            self.assertEqual(payload['dimension'], ['day'])
            self.assertEqual(payload['metrics'], ['ordered_units', 'delivered_units', 'revenue'])
            return {'result': {'data': [
                analytics_row('2026-11-19', [7, 4, 2270]),
                analytics_row('2026-11-21', [2, 1, 500]),
            ]}}

        api = Ozon('123', 'secret', transport=transport)
        result = api.daily_sales('2026-11-19', '2026-11-21', lambda _: None)

        self.assertEqual(len(calls), 1)
        self.assertTrue(result['delivered_available'])
        self.assertEqual(result['rows'], [
            {'date': '2026-11-19', 'ordered_units': 7, 'delivered_units': 4, 'ordered_revenue': 2270.0},
            {'date': '2026-11-20', 'ordered_units': 0, 'delivered_units': 0, 'ordered_revenue': 0.0},
            {'date': '2026-11-21', 'ordered_units': 2, 'delivered_units': 1, 'ordered_revenue': 500.0},
        ])

    def test_missing_premium_metric_falls_back_to_free_ordered_units(self):
        calls = []

        def transport(path, payload):
            calls.append(payload)
            if 'delivered_units' in payload['metrics']:
                raise ApiError('Ozon HTTP 403. Проверьте права.')
            self.assertEqual(payload['metrics'], ['ordered_units', 'revenue'])
            return {'result': {'data': [
                analytics_row('2026-11-20', [9, 3100]),
            ]}}

        api = Ozon('123', 'secret', transport=transport)
        result = api.daily_sales('2026-11-20', '2026-11-20', lambda _: None)

        self.assertEqual(len(calls), 2)
        self.assertFalse(result['delivered_available'])
        self.assertIn('delivered_units', result['delivered_error'])
        self.assertEqual(result['rows'][0]['ordered_units'], 9)
        self.assertIsNone(result['rows'][0]['delivered_units'])
        self.assertEqual(result['rows'][0]['ordered_revenue'], 3100.0)

    def test_duplicate_day_rows_are_summed(self):
        def transport(path, payload):
            return {'result': {'data': [
                analytics_row('2026-11-20', [2, 1, 100]),
                analytics_row('2026-11-20', [3, 2, 200]),
            ]}}

        result = Ozon('123', 'secret', transport=transport).daily_sales(
            '2026-11-20', '2026-11-20', lambda _: None,
        )
        self.assertEqual(result['rows'][0]['ordered_units'], 5)
        self.assertEqual(result['rows'][0]['delivered_units'], 3)
        self.assertEqual(result['rows'][0]['ordered_revenue'], 300.0)

    def test_invalid_period_is_rejected(self):
        api = Ozon('123', 'secret', transport=lambda *_: {})
        with self.assertRaises(ApiError):
            api.daily_sales('2026-11-21', '2026-11-20', lambda _: None)

    def test_period_over_93_days_is_rejected(self):
        api = Ozon('123', 'secret', transport=lambda *_: {})
        with self.assertRaises(ApiError):
            api.daily_sales('2026-08-01', '2026-11-20', lambda _: None)


if __name__ == '__main__':
    unittest.main()
