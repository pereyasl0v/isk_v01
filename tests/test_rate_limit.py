import unittest

from backend.legacy import Ozon, ALLOWED


class RateLimitTests(unittest.TestCase):
    def test_reuses_same_placement_report_creation(self):
        ALLOWED.add('/v1/report/placement/by-products/create')
        calls = []

        def transport(path, payload):
            calls.append((path, payload))
            return {'code': 'REPORT-1'}

        api = Ozon('123', 'secret', transport=transport)
        payload = {'date_from': '2026-09-30', 'date_to': '2026-10-10'}
        first = api.call('/v1/report/placement/by-products/create', payload)
        second = api.call('/v1/report/placement/by-products/create', payload)

        self.assertEqual(first, {'code': 'REPORT-1'})
        self.assertEqual(second, first)
        self.assertEqual(len(calls), 1)

    def test_different_report_periods_are_not_mixed(self):
        ALLOWED.add('/v1/report/placement/by-products/create')
        calls = []

        def transport(path, payload):
            calls.append((path, payload))
            return {'code': f'REPORT-{len(calls)}'}

        api = Ozon('123', 'secret', transport=transport)
        first = api.call('/v1/report/placement/by-products/create', {
            'date_from': '2026-09-30', 'date_to': '2026-10-10',
        })
        second = api.call('/v1/report/placement/by-products/create', {
            'date_from': '2026-10-01', 'date_to': '2026-10-10',
        })

        self.assertNotEqual(first['code'], second['code'])
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
