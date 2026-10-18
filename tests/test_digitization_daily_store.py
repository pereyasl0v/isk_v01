import tempfile
import unittest
from datetime import date

from backend.digitization_cache import combine_digitization_days
from backend.storage import Store


class DigitizationDailyStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(f'{self.temp.name}/inventory.sqlite3')
        self.client = '123'

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def day(day, revenue=0, orders=0, returns=0):
        return {
            'since': day, 'to': day, 'effective_to': day,
            'current_day_excluded': False,
            'accrual_types': [], 'accrual_rows': [], 'by_day_fee_rows': [],
            'sales_facts': {
                'revenue': revenue, 'partner_programs': 0, 'discount_points': 0,
                'products': [],
            },
            'buyout_products': [], 'buyout_error': None,
            'placement_cost': None, 'placement_error': None,
            'returns': {'quantity': returns, 'rows': returns, 'by_type': {},
                        'date_filter': 'visual_status_change_moment'},
            'returns_error': None,
            'orders': {'amount': orders, 'quantity': int(orders > 0), 'postings': int(orders > 0),
                       'fbo': int(orders > 0), 'fbs': 0, 'errors': []},
            'local_daily_source': True,
        }

    def test_one_month_supports_arbitrary_subperiod_without_period_snapshot(self):
        for day, revenue in [('2026-09-01', 100), ('2026-09-02', 200), ('2026-09-03', 300)]:
            self.store.save_digitization_day(self.client, day, self.day(day, revenue=revenue))

        coverage = self.store.digitization_coverage(self.client, '2026-09-02', '2026-09-03')
        self.assertTrue(coverage['complete'])
        self.assertEqual(coverage['available_days'], 2)
        self.assertEqual(coverage['missing_days'], [])

        rows = self.store.digitization_days_between(self.client, '2026-09-02', '2026-09-03')
        combined = combine_digitization_days(
            rows, date(2026, 9, 2), date(2026, 9, 3), date(2026, 9, 3)
        )
        self.assertEqual(combined['sales_facts']['revenue'], 500)
        self.assertEqual(combined['since'], '2026-09-02')
        self.assertEqual(combined['to'], '2026-09-03')

    def test_only_missing_days_are_reported(self):
        self.store.save_digitization_day(self.client, '2026-09-01', self.day('2026-09-01'))
        self.store.save_digitization_day(self.client, '2026-09-03', self.day('2026-09-03'))

        missing = self.store.digitization_missing_days(self.client, '2026-09-01', '2026-09-03')
        self.assertEqual(missing, ['2026-09-02'])
        coverage = self.store.digitization_coverage(self.client, '2026-09-01', '2026-09-03')
        self.assertFalse(coverage['complete'])
        self.assertEqual(coverage['available_days'], 2)

    def test_combiner_sums_orders_and_customer_decisions(self):
        rows = [
            {'day': '2026-09-01', **self.day('2026-09-01', orders=100, returns=1)},
            {'day': '2026-09-02', **self.day('2026-09-02', orders=250, returns=2)},
        ]
        combined = combine_digitization_days(
            rows, date(2026, 9, 1), date(2026, 9, 2), date(2026, 9, 2)
        )
        self.assertEqual(combined['orders']['amount'], 350)
        self.assertEqual(combined['orders']['quantity'], 2)
        self.assertEqual(combined['returns']['quantity'], 3)


if __name__ == '__main__':
    unittest.main()
