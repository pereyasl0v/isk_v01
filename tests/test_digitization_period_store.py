import tempfile
import unittest
from pathlib import Path

from backend.storage import Store


class DigitizationPeriodStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.temp.name)/'test.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def test_saved_digitization_snapshot_is_available_by_exact_period(self):
        payload={
            'since':'2026-09-30','to':'2026-10-11','effective_to':'2026-10-10',
            'accrual_types':[],'accrual_rows':[],'by_day_fee_rows':[],
            'sales_facts':{},'buyout_products':[],'orders':{},
        }
        self.store.save('123','digitization',payload)

        cached=self.store.digitization_period('123','2026-09-30','2026-10-11')
        self.assertIsNotNone(cached)
        self.assertEqual(cached['since'],'2026-09-30')
        self.assertEqual(cached['to'],'2026-10-11')
        self.assertEqual(cached['effective_to'],'2026-10-10')
        self.assertTrue(cached.get('at'))

    def test_periods_are_isolated_by_client_and_exact_range(self):
        self.store.save('123','digitization',{'since':'2026-10-01','to':'2026-10-10'})
        self.assertIsNotNone(self.store.digitization_period('123','2026-10-01','2026-10-10'))
        self.assertIsNone(self.store.digitization_period('999','2026-10-01','2026-10-10'))
        self.assertIsNone(self.store.digitization_period('123','2026-10-02','2026-10-10'))

    def test_new_snapshot_replaces_same_period_local_copy(self):
        self.store.save('123','digitization',{'since':'2026-10-01','to':'2026-10-10','marker':1})
        self.store.save('123','digitization',{'since':'2026-10-01','to':'2026-10-10','marker':2})
        cached=self.store.digitization_period('123','2026-10-01','2026-10-10')
        self.assertEqual(cached['marker'],2)
        self.assertEqual(self.store.digitization_period_count('123'),1)


if __name__=='__main__':
    unittest.main()
