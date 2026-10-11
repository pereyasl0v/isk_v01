import unittest

from backend.digitization import summarize


class DigitizationTests(unittest.TestCase):
    def test_truestats_reconciliation_metrics(self):
        snapshot = {
            'at': '2026-10-11T10:00:00Z',
            'since': '2026-10-01',
            'to': '2026-10-11',
            'accrual_types': [
                {'id': 1, 'name': 'Выручка', 'description': 'Продажа'},
                {'id': 2, 'name': 'Возврат выручки', 'description': 'Возврат'},
                {'id': 3, 'name': 'Логистика'},
                {'id': 4, 'name': 'Логистика - отмена начисления'},
                {'id': 5, 'name': 'Эквайринг'},
                {'id': 6, 'name': 'Размещение товаров на складе Ozon'},
                {'id': 7, 'name': 'Программы партнеров'},
                {'id': 8, 'name': 'Компенсация за потерю по вине Ozon'},
                {'id': 9, 'name': 'Неизвестное удержание'},
                {'id': 10, 'name': 'Баллы за скидки'},
            ],
            'accruals': [
                {
                    'accrual_id': 1,
                    'unit_number': 'sale-1',
                    'total_amount': {'amount': '700'},
                    'posting': {'products': [{
                        'sku': 123,
                        'commission': {
                            'seller_price': {'amount': '1000'},
                            'commission': {'amount': '-100'},
                            'bonus': {'amount': '300'},
                        },
                    }]},
                },
                {
                    'accrual_id': 2,
                    'unit_number': 'return-1',
                    'total_amount': {'amount': '-150'},
                    'posting': {'products': [{
                        'sku': 123,
                        'commission': {
                            'seller_price': {'amount': '200'},
                            'commission': {'amount': '-20'},
                            'bonus': {'amount': '50'},
                        },
                    }]},
                },
                {'accrual_id': 3, 'total_amount': {'amount': '-30'}},
                {'accrual_id': 4, 'total_amount': {'amount': '5'}},
                {'accrual_id': 5, 'total_amount': {'amount': '-2'}},
                {'accrual_id': 6, 'total_amount': {'amount': '-10'}},
                {'accrual_id': 7, 'total_amount': {'amount': '25'}},
                {'accrual_id': 8, 'total_amount': {'amount': '40'}},
                {'accrual_id': 9, 'total_amount': {'amount': '-7'}},
                {'accrual_id': 10, 'total_amount': {'amount': '250'}},
            ],
            'buyout_products': [{
                'sku': 456,
                'quantity': 2,
                'seller_price_per_instance': 95,
                'buyout_price': 90,
            }],
            'orders': {'amount': 2500, 'quantity': 4, 'postings': 3, 'errors': []},
        }

        result = summarize(snapshot)
        m = result['metrics']
        self.assertEqual(m['realization'], 990.0)
        self.assertEqual(m['logistics'], 25.0)
        self.assertEqual(m['storage'], 10.0)
        self.assertEqual(m['nominal_commission'], 90.0)
        self.assertEqual(m['acquiring'], 2.0)
        self.assertIsNone(m['advertising'])
        self.assertEqual(m['sales_quantity'], 2)
        self.assertEqual(m['sales_amount'], 765.0)
        self.assertEqual(m['orders_amount'], 2500.0)
        self.assertEqual(m['orders_quantity'], 4)
        self.assertEqual(m['discount_points'], 250.0)
        self.assertEqual(m['compensations'], 40.0)
        self.assertEqual(m['other_deductions'], 7.0)

        self.assertEqual(result['components']['marketplace_buyout_realization'], 190.0)
        self.assertEqual(result['components']['marketplace_buyout_commission'], 10.0)

    def test_type_name_not_description_drives_grouping(self):
        result = summarize({
            'accrual_types': [{'id': 5, 'name': 'Эквайринг', 'description': 'Другое описание'}],
            'accruals': [{'accrual_id': 5, 'total_amount': {'amount': '-12.5'}}],
            'buyout_products': [],
            'orders': {},
        })
        self.assertEqual(result['metrics']['acquiring'], 12.5)
        self.assertEqual(result['metrics']['other_deductions'], 0.0)


if __name__ == '__main__':
    unittest.main()
