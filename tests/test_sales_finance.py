import unittest
from unittest.mock import patch

from backend.sales_finance import add_financial_sales


def orders():
    return {
        'date_from':'2026-11-18','date_to':'2026-11-20',
        'rows':[
            {'date':'2026-11-18','ordered_units':3,'ordered_revenue':600},
            {'date':'2026-11-19','ordered_units':8,'ordered_revenue':1700},
            {'date':'2026-11-20','ordered_units':2,'ordered_revenue':400},
        ],
        'by_sku':[
            {'sku':'101','date':'2026-11-19','ordered_units':8,'ordered_revenue':1700},
            {'sku':'101','date':'2026-11-20','ordered_units':2,'ordered_revenue':400},
        ],
    }


class DailyFinancialSalesTests(unittest.TestCase):
    def test_real_sales_per_day_and_sku_do_not_use_delivered_metric(self):
        summary={
            'metrics':{'sales_quantity':5,'sales_amount':1234.5},
            'products':[
                {'sku':'101','sales_quantity':3,'sales_amount':700},
                {'sku':'102','sales_quantity':2,'sales_amount':534.5},
            ],
        }
        with patch('backend.sales_finance.summarize_digitization',return_value=summary):
            result=add_financial_sales(orders(),[
                {'day':'2026-11-19','buyout_error':None},
            ])
        self.assertEqual(result['rows'][1]['sold_units'],5)
        self.assertEqual(result['rows'][1]['sold_amount'],1234.5)
        self.assertIsNone(result['rows'][0]['sold_units'])
        self.assertIsNone(result['rows'][2]['sold_units'])
        self.assertEqual(result['financial_sales_missing_days'],['2026-11-18','2026-11-20'])
        per_sku={(item['sku'],item['date']):item for item in result['by_sku']}
        self.assertEqual(per_sku[('101','2026-11-19')]['sold_units'],3)
        self.assertEqual(per_sku[('102','2026-11-19')]['sold_units'],2)
        self.assertFalse(result['rows'][1]['sales_partial'])
        self.assertEqual(result['financial_sales_source'],'sqlite_digitization_days')

    def test_missing_sku_allocation_is_marked_partial_not_zero(self):
        summary={
            'metrics':{'sales_quantity':4,'sales_amount':800},
            'products':[{'sku':'101','sales_quantity':2,'sales_amount':400}],
        }
        with patch('backend.sales_finance.summarize_digitization',return_value=summary):
            result=add_financial_sales(orders(),[{'day':'2026-11-19'}])
        self.assertTrue(result['rows'][1]['sales_partial'])
        self.assertEqual(result['financial_sales_incomplete_days'],['2026-11-19'])

    def test_marketplace_buyout_load_failure_marks_finance_partial(self):
        summary={
            'metrics':{'sales_quantity':1,'sales_amount':150},
            'products':[{'sku':'101','sales_quantity':1,'sales_amount':150}],
        }
        with patch('backend.sales_finance.summarize_digitization',return_value=summary):
            result=add_financial_sales(orders(),[
                {'day':'2026-11-19','buyout_error':'Ozon temporarily unavailable'},
            ])
        self.assertTrue(result['rows'][1]['sales_partial'])

    def test_invalid_financial_day_is_not_invented(self):
        with patch('backend.sales_finance.summarize_digitization',side_effect=ValueError):
            result=add_financial_sales(orders(),[{'day':'2026-11-19'}])
        self.assertFalse(result['financial_sales_available'])
        self.assertTrue(all(x['sold_units'] is None for x in result['rows']))


if __name__=='__main__':
    unittest.main()
