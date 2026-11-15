import base64
import os
import tempfile
import unittest
from datetime import datetime
from io import BytesIO
from pathlib import Path

scratch = tempfile.TemporaryDirectory()
os.environ["OZON_FBO_DATA_DIR"] = scratch.name
os.environ["ISK_ENCRYPTION_KEY"] = base64.urlsafe_b64encode(b"isk-test-key-32-bytes-0123456789").decode("ascii")

from fastapi.testclient import TestClient
from openpyxl import Workbook
from backend import main
from backend.costing import calculate_workspace, parse_legacy_xlsx
from backend.security import hash_password
from backend.storage import Store

HEAD = {"Origin": "http://127.0.0.1:8000"}


def sample_xlsx():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Китай"
    sheet.append([
        "Дата отпр.", "Дата пр.", "Поставка", "Наименование товара",
        "Масса нетто ед., г", "Цена ¥, ед.", "Кол-во. ед",
        "Доставка до Гуанчжоу ¥", "Масса нетто, короб, кг",
        "Оплата продавцу ¥", "Курс ¥ - ₽", "1-я оплата ₽", None,
        "Поставка", "Упак. короб. $", "Цена за кг. авто",
        "Масса нетто, кг", "Масса брутто, кг.", "Кол-во короб.",
        "Масса коробки", "Оплата за упаковку $", "¥ - $", "₽ - ¥",
        "Вторая оплата ", "Доставка до СПб ₽", "Доставка до дома ₽",
        "Грузчики ₽", "3-я оплата ₽", "Упаковка ₽", "Себестоимость"
    ])
    rows = [
        ["2026-06-26", "2026-07-25", "AUA-2", "Щипцы СВП", 320, 3.6, 800, 340, None, None, 11.8, None, None,
         "AUA-2510-18-6", 3, 3.2, 280.9, 291, 6, None, 18, 6.8, 12.4, None, 5111, 2000, 2000, None, 1536, None],
        ["2026-06-26", "2026-07-25", "AUA-5", "Уменьшители размера", 5, 0.6, 1500, 0, None, None, 11.8, None, None,
         "AUA-2510-18-6", 3, 3.2, 280.9, 291, 6, None, 18, 6.8, 12.4, None, 5111, 2000, 2000, None, None, None],
        ["2026-06-26", "2026-07-25", "AUA-10", "Шпилькосъёмник", 29, 1.45, 600, 25, None, None, 11.8, None, None,
         "AUA-2510-18-6", 3, 3.2, 280.9, 291, 6, None, 18, 6.8, 12.4, None, 5111, 2000, 2000, None, None, None],
    ]
    for row in rows:
        sheet.append(row)
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


class CostingImportTests(unittest.TestCase):
    def test_imports_three_products_and_one_shipment(self):
        imported = parse_legacy_xlsx(sample_xlsx())
        self.assertEqual(imported["importedProducts"], 3)
        self.assertEqual(imported["importedShipments"], 1)
        self.assertEqual(imported["shipments"][0]["name"], "AUA-2510-18-6")
        self.assertEqual(imported["shipments"][0]["distributionMethod"], "weight")
        self.assertEqual(imported["products"][0]["deliveryToGuangzhouYuan"], 340)
        self.assertEqual(imported["products"][0]["rate"], 11.8)

    def test_recalculates_cost_with_shared_expenses_distributed_by_weight(self):
        imported = parse_legacy_xlsx(sample_xlsx())
        costs = calculate_workspace(imported["products"], imported["shipments"])
        self.assertAlmostEqual(costs[imported["products"][0]["id"]]["costPerUnit"], 150.8012800997)
        self.assertAlmostEqual(costs[imported["products"][1]["id"]]["costPerUnit"], 8.6941606266)
        self.assertAlmostEqual(costs[imported["products"][2]["id"]]["costPerUnit"], 26.9637983007)
        self.assertAlmostEqual(sum(row["allocationShare"] for row in costs.values()), 1)

    def test_rejects_unrelated_workbook(self):
        workbook = Workbook()
        output = BytesIO()
        workbook.save(output)
        with self.assertRaises(ValueError):
            parse_legacy_xlsx(output.getvalue())


class CostingApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        main.store = Store(Path(self.tmp.name) / "db.sqlite", encryption_key=main.ENCRYPTION_KEY)
        main.runtime_accounts.clear()
        main.store.create_user("admin", hash_password("Admin-Password-2026!"), "admin")
        self.client = TestClient(main.app)
        login = self.client.post("/api/auth/login", headers=HEAD, json={
            "username": "admin", "password": "Admin-Password-2026!"
        })
        self.assertEqual(login.status_code, 200, login.text)

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_workspace_persists_and_rejects_stale_revision(self):
        initial = self.client.get("/api/costing")
        self.assertEqual(initial.status_code, 200, initial.text)
        self.assertEqual(initial.json()["revision"], 0)
        body = {
            "revision": 0,
            "products": [{"id": "p1", "name": "Товар", "yuan": 3.6, "rate": 11.8, "freight": 0,
                          "quantity": 2, "status": "selected", "shipmentId": ""}],
            "shipments": []
        }
        saved = self.client.put("/api/costing", headers=HEAD, json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["revision"], 1)
        stale = self.client.put("/api/costing", headers=HEAD, json=body)
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(self.client.get("/api/costing").json()["products"][0]["name"], "Товар")

    def test_excel_import_is_repeatable_and_returns_calculated_costs(self):
        raw = sample_xlsx()
        encoded = base64.b64encode(raw).decode("ascii")
        body = {"filename": "Насте (1).xlsx", "file_base64": encoded}
        first = self.client.post("/api/costing/import-xlsx", headers=HEAD, json=body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["importedProducts"], 3)
        self.assertEqual(first.json()["importedShipments"], 1)
        self.assertAlmostEqual(first.json()["calculated"][first.json()["products"][0]["id"]]["costPerUnit"], 150.8012800997)
        second = self.client.post("/api/costing/import-xlsx", headers=HEAD, json=body)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(len(second.json()["products"]), 3)
        self.assertEqual(len(second.json()["shipments"]), 1)

    def test_workspace_requires_login_and_is_user_scoped(self):
        anonymous = TestClient(main.app)
        try:
            self.assertEqual(anonymous.get("/api/costing").status_code, 401)
        finally:
            anonymous.close()
        other = main.store.create_user("seller2", hash_password("Seller-Password-2026!"), "user")
        client = TestClient(main.app)
        try:
            login = client.post("/api/auth/login", headers=HEAD, json={
                "username": "seller2", "password": "Seller-Password-2026!"
            })
            self.assertEqual(login.status_code, 200, login.text)
            self.assertEqual(client.get("/api/costing").json()["products"], [])
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
