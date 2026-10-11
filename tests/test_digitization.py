import unittest

from backend.digitization import summarize


class DigitizationTests(unittest.TestCase):
    def test_current_accrual_schema_is_aggregated(self):
        snapshot = {
            'at': '2026-10-11T10:00:00Z',
            'since': '2026-10-10',
            'to': '2026-10-11',
            'accrual_types': [
                {'id': 101, 'name': 'DeliveryLogistic', 'description': 'Логистика'},
                {'id': 102, 'name': 'StorageFee', 'description': 'Хранение'},
                {'id': 103, 'name': 'Acquiring', 'description': 'Эквайринг'},
                {'id': 500, 'name': 'PostingAccrual', 'description': 'Продажа'},
            ],
            'accruals': [{
                'accrual_id': 500,
                'total_amount': {'amount': '900.00', 'currency': 'RUB'},
                'posting': {'products': [{
                    'sku': '12345',
                    'commission': {
                        'seller_price': {'amount': '1000.00', 'currency': 'RUB'},
                        'sale_commission': {'amount': '-100.00', 'currency': 'RUB'},
                    },
                    'delivery': {
                        'total_accrued': {'amount': '-30.00', 'currency': 'RUB'},
                        'services': [{
                            'type_id': 101,
                            'accrued': {'amount': '-30.00', 'currency': 'RUB'},
                        }],
                    },
                }]},
                'item_fees': {'fees': [{
                    'sku': '12345',
                    'fees': [{
                        'type_id': 102,
                        'accrued': {'amount': '-5.00', 'currency': 'RUB'},
                    }],
                }]},
                'non_item_fee': {
                    'type_id': 103,
                    'accrued': {'amount': '-2.00', 'currency': 'RUB'},
                },
            }],
        }

        result = summarize(snapshot)
        totals = result['totals']
        self.assertEqual(totals['gross_sales'], 1000.0)
        self.assertEqual(totals['commission'], 100.0)
        self.assertEqual(totals['logistics'], 30.0)
        self.assertEqual(totals['storage'], 5.0)
        self.assertEqual(totals['other_services'], 2.0)
        self.assertEqual(totals['ozon_expenses'], 137.0)
        self.assertEqual(totals['net_accrual'], 900.0)

        product = result['products'][0]
        self.assertEqual(product['sku'], '12345')
        self.assertEqual(product['gross_sales'], 1000.0)
        self.assertEqual(product['commission'], 100.0)
        self.assertEqual(product['services'], 35.0)
        self.assertEqual(product['net_accrual'], 865.0)

    def test_unknown_fee_stays_in_other_services(self):
        result = summarize({
            'accrual_types': [],
            'accruals': [{
                'total_amount': {'amount': '-4.5'},
                'non_item_fee': {'type_id': 999, 'accrued': {'amount': '-4.5'}},
            }],
        })
        self.assertEqual(result['totals']['other_services'], 4.5)
        self.assertEqual(result['totals']['net_accrual'], -4.5)


if __name__ == '__main__':
    unittest.main()
