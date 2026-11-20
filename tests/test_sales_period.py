import unittest
from datetime import datetime, timezone, timedelta
from backend.sales_period import closed_sales_period, sales_chart_period


class SalesReportingPeriodTests(unittest.TestCase):
    def test_90_completed_moscow_days_plus_today(self):
        # November 20, 2026 in Moscow: identical closed portion to Digitization.
        now=datetime(2026,11,20,12,0,tzinfo=timezone.utc)
        self.assertEqual(tuple(map(str, closed_sales_period(90,now))),
                         ('2026-08-22','2026-11-19'))
        first,today=sales_chart_period(90,now)
        self.assertEqual((str(first),str(today)),('2026-08-22','2026-11-20'))
        self.assertEqual((today-first).days+1,91)

    def test_short_periods_keep_same_closed_range_plus_today(self):
        now=datetime(2026,11,20,12,0,tzinfo=timezone.utc)
        for days in (7,14,30,90):
            first,last=sales_chart_period(days,now)
            closed_first,closed_last=closed_sales_period(days,now)
            self.assertEqual(first,closed_first)
            self.assertEqual(last,closed_last+timedelta(days=1))
            self.assertEqual((last-first).days+1,days+1)

    def test_moscow_midnight_crossing(self):
        # 22:30 UTC is 01:30 on Nov 20 in Moscow.
        now=datetime(2026,11,19,22,30,tzinfo=timezone.utc)
        self.assertEqual(tuple(map(str,sales_chart_period(7,now))),
                         ('2026-11-13','2026-11-20'))

    def test_invalid_period_and_naive_time(self):
        for n in (0,91,-1,1.5,True):
            with self.assertRaises(ValueError):
                sales_chart_period(n)
        with self.assertRaises(ValueError):
            sales_chart_period(7,datetime(2026,11,20))


if __name__=='__main__':
    unittest.main()
