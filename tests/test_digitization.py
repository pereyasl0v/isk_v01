import unittest

from backend.digitization import summarize


TYPES = [
    {'id': 1, 'name': 'Выручка'},
    {'id': 2, 'name': 'Возврат выручки'},
    {'id': 3, 'name': 'Программы партнёров'},
    {'id': 4, 'name': 'Вознаграждение за продажу'},
    {'id': 5, 'name': 'Возврат вознаграждения'},
    {'id': 6, 'name': 'Логистика'},
    {'id': 7, 'name': 'Логистика - отмена начисления'},
    {'id': 8, 'name': 'Эквайринг'},
    {'id': 9, 'name': 'Баллы за скидки'},
    {'id': 10, 'name': 'Продвижение с оплатой за заказ'},
    {'id': 11, 'name': 'Неизвестное удержание'},
    {'id': 12, 'name': 'Компенсация за потерю по вине Ozon'},
    {'id': 13, 'name': 'Хранение'},
]


def row(type_id, amount, quantity=0, seller_price=0, sku=None):
    return {
        'type_id': type_id,
        'amount': amount,
        'quantity': quantity,
        'seller_price': seller_price,
        'sku': sku,
    }


class DigitizationTests(unittest.TestCase):
    def test_truestats_reconciliation_metrics(self):
        snapshot = {
            'at': '2026-10-11T10:00:00Z',
            'since': '2026-10-01',
            'to': '2026-10-11',
            'effective_to': '2026-10-10',
            'accrual_types': TYPES,
            'accrual_rows': [
                row(1, 700, 1, 1000, 123),
                row(2, -150, 1, 200, 123),
                row(3, 25, 1, 1000, 123),
                row(4, -100, 1, 1000, 123),
                row(5, 20, 1, 200, 123),
                row(6, -30),
                row(7, 5),
                row(8, -2),
                row(9, 250),
                row(10, -12),
                row(11, -7),
                row(12, 40),
                row(13, -10),
            ],
            'buyout_products': [{
                'sku': 456,
                'quantity': 2,
                'seller_price_per_instance': 95,
                'buyout_price': 90,
                'amount': 180,
            }],
            'placement_cost': 11.5,
            'orders': {'amount': 2500, 'quantity': 4, 'postings': 3, 'errors': []},
        }

        result = summarize(snapshot)
        m = result['metrics']
        self.assertEqual(m['realization'], 990.0)
        self.assertEqual(m['sales_amount'], 905.0)
        self.assertEqual(m['sales_quantity'], 2)
        self.assertEqual(m['returns_amount'], 200.0)
        self.assertEqual(m['returns_quantity'], 1)
        self.assertEqual(m['logistics'], 25.0)
        self.assertEqual(m['storage'], 11.5)
        self.assertEqual(m['nominal_commission'], 90.0)
        self.assertEqual(m['acquiring'], 2.0)
        self.assertEqual(m['advertising'], 12.0)
        self.assertEqual(m['discount_points'], 250.0)
        self.assertEqual(m['compensations'], 40.0)
        self.assertEqual(m['other_deductions'], 7.0)
        self.assertEqual(m['orders_amount'], 2500.0)
        self.assertEqual(m['orders_quantity'], 4)
        self.assertEqual(m['logistics_share'], 2.53)
        self.assertEqual(m['nominal_commission_share'], 9.09)

        self.assertEqual(result['summary']['price_before_spp'], 495.0)
        self.assertEqual(result['summary']['average_sale_price'], 452.5)
        self.assertEqual(result['summary']['returns'], 200.0)
        self.assertEqual(result['components']['marketplace_buyout_realization'], 190.0)
        self.assertEqual(result['components']['marketplace_buyout_sales'], 180.0)
        self.assertEqual(result['components']['marketplace_buyout_commission'], 10.0)

    def test_uploaded_ozon_reports_match_truestats_cards_through_closed_day(self):
        """Reference totals from the seller reports supplied for 30.09–11.10.2026.

        TrueStats screenshot was taken on 11.10 and displays closed data through 10.10.
        The values below are direct aggregates from the supplied Ozon reports.
        """
        snapshot = {
            'since': '2026-09-30',
            'to': '2026-10-11',
            'effective_to': '2026-10-10',
            'current_day_excluded': True,
            'accrual_types': TYPES,
            'accrual_rows': [
                row(1, 32819.17, 121, 58489 / 121, 100),
                row(2, -387.62, 1, 805, 100),
                row(3, 291.48, 121, 0, 100),
                row(4, -26368.52),
                row(6, -8429.05),
                row(8, -544.41),
                row(9, 24960.97),
                row(10, -1375.00),
                row(11, -75.00),
            ],
            'buyout_products': [{
                'sku': 200,
                'quantity': 2,
                'seller_price_per_instance': 460,
                'buyout_price': 230.5,
                'amount': 461,
            }],
            'placement_cost': 0,
            'orders': {'amount': 51745, 'quantity': 125, 'errors': []},
        }
        m = summarize(snapshot)['metrics']
        self.assertEqual(m['realization'], 58604.0)
        self.assertEqual(m['sales_amount'], 33571.65)
        self.assertEqual(m['sales_quantity'], 122)
        self.assertEqual(m['returns_amount'], 805.0)
        self.assertEqual(m['returns_quantity'], 1)
        self.assertEqual(m['logistics'], 8429.05)
        self.assertEqual(m['logistics_share'], 14.38)
        self.assertEqual(m['nominal_commission'], 26827.52)
        self.assertEqual(m['nominal_commission_share'], 45.78)
        self.assertEqual(m['acquiring'], 544.41)
        self.assertEqual(m['advertising'], 1375.0)
        self.assertEqual(m['other_deductions'], 75.0)

    def test_storage_falls_back_to_accrual_when_report_unavailable(self):
        result = summarize({
            'accrual_types': TYPES,
            'accrual_rows': [row(13, -12.5)],
            'buyout_products': [],
            'placement_error': 'report unavailable',
            'orders': {},
        })
        self.assertEqual(result['metrics']['storage'], 12.5)
        self.assertFalse(result['components']['storage_from_placement_report'])

    def test_type_name_not_description_drives_grouping(self):
        result = summarize({
            'accrual_types': [{'id': 8, 'name': 'Эквайринг', 'description': 'Другое описание'}],
            'accrual_rows': [row(8, -12.5)],
            'buyout_products': [],
            'orders': {},
        })
        self.assertEqual(result['metrics']['acquiring'], 12.5)
        self.assertEqual(result['metrics']['other_deductions'], 0.0)

    def test_profit_metrics_are_only_calculated_when_seller_inputs_exist(self):
        result = summarize({
            'accrual_types': TYPES,
            'accrual_rows': [row(1, 800, 1, 1000, 123)],
            'buyout_products': [],
            'orders': {},
            'clean_profit': 200,
            'taxes': 50,
            'cogs': 400,
        })
        self.assertEqual(result['metrics']['clean_profit'], 200.0)
        self.assertEqual(result['metrics']['margin'], 20.0)
        self.assertEqual(result['metrics']['roi'], 50.0)
        self.assertEqual(result['metrics']['average_profit'], 200.0)
        self.assertEqual(result['metrics']['taxes'], 50.0)
        self.assertEqual(result['metrics']['taxes_share'], 5.0)


if __name__ == '__main__':
    unittest.main()
