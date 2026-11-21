import base64
import os
import tempfile
import unittest
from pathlib import Path

scratch = tempfile.TemporaryDirectory()
os.environ["OZON_FBO_DATA_DIR"] = scratch.name
os.environ["ISK_ENCRYPTION_KEY"] = base64.urlsafe_b64encode(
    b"isk-test-key-32-bytes-0123456789"
).decode("ascii")

from fastapi.testclient import TestClient
from backend import main
from backend.costing import number
from backend.preliminary_costing import clean_preliminary_cost, calculate_preliminary_cost
from backend.security import hash_password
from backend.storage import Store

HEAD = {"Origin": "http://127.0.0.1:8000"}


def sample_draft():
    return {
        "products": [
            {
                "id": "p1", "name": "Щипцы СВП", "article": "AUA-2",
                "quantity": 800, "unitPriceYuan": 3.6,
                "deliveryToSashaYuan": 0, "deliveryToGuangzhouYuan": 340,
                "dutyPercent": 6.5, "volumeM3": 0.3,
                "grossWeightKg": 291, "netWeightKg": 256,
                "unitNetWeightG": 320,
            },
            {
                "id": "p2", "name": "Уменьшители размера", "article": "AUA-5",
                "quantity": 1500, "unitPriceYuan": 0.6,
                "deliveryToSashaYuan": 0, "deliveryToGuangzhouYuan": 0,
                "dutyPercent": 10, "volumeM3": 0.3,
                "grossWeightKg": 7.5, "netWeightKg": 7.5,
                "unitNetWeightG": 5,
            },
            {
                "id": "p3", "name": "Шпилькосъемник", "article": "AUA-10",
                "quantity": 600, "unitPriceYuan": 1.45,
                "deliveryToSashaYuan": 0, "deliveryToGuangzhouYuan": 25,
                "dutyPercent": 6.5, "volumeM3": 2,
                "grossWeightKg": 17.4, "netWeightKg": 17.4,
                "unitNetWeightG": 29,
            },
        ],
        "route1": {
            "yuanToRubRate": 14.2, "purchaseMarkupPercent": 7,
            "freightRateRubPerM3": 17000 * 95 / 65,
            "dutyableFreightPercent": 60, "vatPercent": 22,
            "ownTaxPercent": 20, "deliveryToSpbRub": 0,
            "loadersRub": 0, "unloadersRub": 0, "otherRub": 0,
            "allocationMethod": "volume",
        },
        "route2": {
            "purchaseYuanToRubRate": 11.8, "usdToYuanRate": 6.8,
            "freightYuanToRubRate": 12.4, "autoFreightUsdPerKg": 3.2,
            "packagingPerBoxUsd": 3, "boxCount": 6, "grossWeightKg": 291,
            "deliveryToSpbRub": 5111, "deliveryToHomeRub": 2000,
            "loadersRub": 2000, "packingRub": 1536, "otherRub": 0,
        },
    }


class PreliminaryCostCalculationTests(unittest.TestCase):
    def test_selected_route_uses_its_own_rate_and_ignores_other_route(self):
        draft = sample_draft()
        draft.update(selectedRoute="route2", yuanToRubRate=99)
        draft["route1"].update(containerCostUsd=17_000, containerVolumeM3=0)
        draft["route2"]["purchaseYuanToRubRate"] = 10
        result = calculate_preliminary_cost(clean_preliminary_cost(draft))
        self.assertEqual(set(result["summary"]), {"route2"})
        self.assertAlmostEqual(result["products"][0]["route2"]["purchaseRub"], (800 * 3.6 + 340) * 10)
        self.assertAlmostEqual(result["summary"]["route2"]["transportRub"], (291 * 3.2 + 18) * 6.8 * 10)
        self.assertNotIn("route1", result["products"][0])

    def test_packaging_percentage_replaces_manual_gross_and_extra_expenses(self):
        draft = sample_draft()
        draft["packagingWeightPercent"] = 10
        draft["route1"]["deliveryToSpbRub"] = 5_000
        clean = clean_preliminary_cost(draft)
        summary = calculate_preliminary_cost(clean)["summary"]
        self.assertAlmostEqual(summary["route2"]["grossWeightKg"], 280.9 * 1.1)
        self.assertEqual(summary["route1"]["sharedExpensesRub"], 0)
        self.assertEqual(summary["route2"]["sharedExpensesRub"], 0)

    def test_rostov_freight_uses_container_parameters(self):
        draft = sample_draft()
        draft["route1"].update(containerCostUsd=20_000, usdToRubRate=100, containerVolumeM3=50)
        clean = clean_preliminary_cost(draft)
        self.assertEqual(clean["route1"]["containerVolumeM3"], 50)
        self.assertEqual(calculate_preliminary_cost(clean)["products"][0]["route1"]["freightToRostovRub"], 12_000)
        draft["route1"]["containerVolumeM3"] = 0
        with self.assertRaises(ValueError):
            clean_preliminary_cost(draft)

    def test_rostov_dollar_rate_rescales_saved_freight_tariff(self):
        draft = sample_draft()
        draft["route1"]["freightRateRubPerM3"] = 19_000
        draft["route1"]["usdToRubRate"] = 100
        clean = clean_preliminary_cost(draft)
        self.assertEqual(clean["route1"]["usdToRubRate"], 100)
        result = calculate_preliminary_cost(clean)
        self.assertAlmostEqual(result["products"][0]["route1"]["freightToRostovRub"], 6_000)

    def test_common_yuan_rate_applies_to_all_route_conversions(self):
        draft = sample_draft()
        original = calculate_preliminary_cost(clean_preliminary_cost(draft))
        draft["yuanToRubRate"] = "15,5"
        clean = clean_preliminary_cost(draft)
        self.assertEqual(clean["yuanToRubRate"], 15.5)
        result = calculate_preliminary_cost(clean)
        before, after = original["products"][0], result["products"][0]
        self.assertAlmostEqual(after["route1"]["goodsRub"], before["route1"]["goodsRub"] * 15.5 / 14.2)
        self.assertAlmostEqual(after["route2"]["purchaseRub"], before["route2"]["purchaseRub"] * 15.5 / 11.8)
        self.assertAlmostEqual(after["route2"]["transportRub"], before["route2"]["transportRub"] * 15.5 / 12.4)

    def test_dimensions_override_archived_volume_for_freight_and_allocation(self):
        draft = sample_draft()
        draft["products"] = draft["products"][:2]
        draft["products"][0].update(lengthCm="2,5", widthCm=4, heightCm=5, quantity=1_000, unitNetWeightG=15)
        draft["route1"].update(freightRateRubPerM3=1_000, deliveryToSpbRub=700)
        clean = clean_preliminary_cost(draft)
        self.assertEqual(clean["products"][0]["lengthCm"], 2.5)
        first, legacy = calculate_preliminary_cost(clean)["products"]
        self.assertAlmostEqual(first["volumeM3"], 0.05)
        self.assertEqual(first["netWeightKg"], 15)
        self.assertEqual(first["route2"]["netWeightKg"], 15)
        self.assertAlmostEqual(first["route1"]["freightToRostovRub"], 50)
        self.assertAlmostEqual(first["route1"]["allocatedAdditionalRub"], 100)
        self.assertAlmostEqual(legacy["volumeM3"], 0.3)
        clean["products"][0]["heightCm"] = 0
        self.assertEqual(calculate_preliminary_cost(clean)["products"][0]["volumeM3"], 0)

    def test_route_one_matches_workbook_two_formula(self):
        draft = {
            "products": [{
                "id": "p1", "name": "Лестница", "quantity": 200,
                "unitPriceYuan": 8.65, "deliveryToSashaYuan": 0,
                "dutyPercent": 6.5, "volumeM3": 0.3,
            }],
            "route1": {
                "yuanToRubRate": 14.2, "purchaseMarkupPercent": 7,
                "freightRateRubPerM3": 17000 * 95 / 65,
                "dutyableFreightPercent": 60, "vatPercent": 22,
                "ownTaxPercent": 20,
            },
            "route2": {},
        }
        result = calculate_preliminary_cost(clean_preliminary_cost(draft))
        row = result["products"][0]["route1"]
        self.assertAlmostEqual(row["goodsRub"], 26285.62, places=6)
        self.assertAlmostEqual(row["freightToRostovRub"], 7453.846153846, places=6)
        self.assertAlmostEqual(row["dutyGoodsRub"], 1708.5653, places=6)
        self.assertAlmostEqual(row["vatGoodsRub"], 5782.8364, places=6)
        self.assertAlmostEqual(row["totalRub"], 51006.570655384625, places=6)
        self.assertAlmostEqual(row["costPerUnit"], 255.03285327692313, places=6)

    def test_route_two_matches_nastya_workbook_and_allocates_shared_cost_once(self):
        result = calculate_preliminary_cost(clean_preliminary_cost(sample_draft()))
        rows = result["products"]
        self.assertAlmostEqual(rows[0]["route2"]["costPerUnit"], 150.80128009967962, places=6)
        self.assertAlmostEqual(rows[1]["route2"]["costPerUnit"], 8.694160626557494, places=6)
        self.assertAlmostEqual(rows[2]["route2"]["costPerUnit"], 26.963798300700134, places=6)
        self.assertAlmostEqual(sum(row["route2"]["allocationShare"] for row in rows), 1.0, places=9)
        self.assertAlmostEqual(
            sum(row["route2"]["sharedExpensesRub"] for row in rows),
            10647,
            places=6,
        )
        self.assertAlmostEqual(result["summary"]["route2"]["totalRub"], 149860.54399999998, places=5)

    def test_route_one_shared_expenses_are_distributed_only_once(self):
        draft = sample_draft()
        draft["route1"]["deliveryToSpbRub"] = 12000
        draft["route1"]["loadersRub"] = 3000
        result = calculate_preliminary_cost(clean_preliminary_cost(draft))
        self.assertAlmostEqual(
            sum(row["route1"]["allocatedAdditionalRub"] for row in result["products"]),
            15000,
            places=6,
        )

    def test_validation_rejects_invalid_quantity_and_percent(self):
        draft = sample_draft()
        draft["products"][0]["quantity"] = 0
        with self.assertRaises(ValueError):
            clean_preliminary_cost(draft)
        draft = sample_draft()
        draft["products"][0]["dutyPercent"] = 101
        with self.assertRaises(ValueError):
            clean_preliminary_cost(draft)

        draft = sample_draft()
        draft["products"][0]["volumeM3"] = 0.05
        with self.assertRaises(ValueError):
            clean_preliminary_cost(draft)


class PreliminaryCostArchiveApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        main.store = Store(Path(self.tmp.name) / "db.sqlite", encryption_key=main.ENCRYPTION_KEY)
        main.runtime_accounts.clear()
        main.store.create_user("admin", hash_password("Admin-Password-2026!"), "admin")
        main.store.create_user("other", hash_password("Other-Password-2026!"), "user")
        self.client = TestClient(main.app)
        self.other = TestClient(main.app)
        self.login(self.client, "admin", "Admin-Password-2026!")

    def tearDown(self):
        self.client.close()
        self.other.close()
        self.tmp.cleanup()

    def login(self, client, username, password):
        response = client.post(
            "/api/auth/login",
            headers=HEAD,
            json={"username": username, "password": password},
        )
        self.assertEqual(response.status_code, 200, response.text)

    def test_form_shipment_persists_independent_cost_snapshot_once(self):
        self.login(self.other, "other", "Other-Password-2026!")
        draft = sample_draft()
        draft["selectedRoute"] = "route1"
        body = {"request_id": "shipment-test", "name": "Закупка", "data": draft}
        endpoint = "/api/purchase-shipments"
        self.assertEqual(self.client.post(endpoint, headers=HEAD, json=body).status_code, 201)
        first = self.client.post(endpoint, headers=HEAD, json=body).json()
        self.assertEqual(len(self.client.get(endpoint).json()["items"]), 1)
        self.assertEqual(self.other.get(endpoint).json()["items"], [])
        shipment_url = f"{endpoint}/{first['id']}"
        self.assertEqual(self.other.get(shipment_url).status_code, 404)
        calculation_url = f"/api/preliminary-costs/{first['calculation_id']}"
        snapshot = self.client.get(shipment_url).json()
        self.assertEqual(snapshot["data"]["selectedRoute"], "route1")
        self.assertIn("route1", snapshot["calculated"]["summary"])

        draft["products"][0]["quantity"] = 1
        updated = self.client.put(calculation_url, headers=HEAD, json={"name": "Новый", "data": draft})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(self.client.delete(calculation_url, headers=HEAD).status_code, 200)
        self.assertEqual(self.client.get(shipment_url).json(), snapshot)

    def test_save_search_edit_and_delete_archive_without_ozon_account(self):
        body = {"name": "Ноябрьская закупка", "data": sample_draft()}
        created = self.client.post("/api/preliminary-costs", headers=HEAD, json=body)
        self.assertEqual(created.status_code, 201, created.text)
        record = created.json()
        self.assertEqual(record["name"], body["name"])
        self.assertEqual(len(record["calculated"]["products"]), 3)

        found = self.client.get("/api/preliminary-costs?q=ЩИПЦЫ", headers=HEAD)
        self.assertEqual(found.status_code, 200, found.text)
        self.assertEqual([item["id"] for item in found.json()["items"]], [record["id"]])

        detail = self.client.get(f"/api/preliminary-costs/{record['id']}", headers=HEAD)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["data"]["products"][0]["name"], "Щипцы СВП")

        updated_data = sample_draft()
        updated_data["products"][0]["unitPriceYuan"] = 4.0
        updated = self.client.put(
            f"/api/preliminary-costs/{record['id']}",
            headers=HEAD,
            json={"name": "Зимняя закупка", "data": updated_data},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["data"]["products"][0]["unitPriceYuan"], 4.0)
        self.assertEqual(updated.json()["created_at"], record["created_at"])
        self.assertEqual(
            self.client.get("/api/preliminary-costs?q=ноябрь", headers=HEAD).json()["items"],
            [],
        )
        self.assertEqual(
            len(self.client.get("/api/preliminary-costs?q=УМЕНЬШИТЕЛИ", headers=HEAD).json()["items"]),
            1,
        )

        with main.store.db() as db:
            payload = db.execute(
                "SELECT payload FROM preliminary_cost_calculations WHERE id=?",
                (record["id"],),
            ).fetchone()[0]
        self.assertTrue(payload.startswith("enc:v1:"))

        deleted = self.client.delete(
            f"/api/preliminary-costs/{record['id']}", headers=HEAD
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(
            self.client.get("/api/preliminary-costs", headers=HEAD).json()["items"],
            [],
        )

    def test_archive_is_private_to_user_and_requires_authentication(self):
        created = self.client.post(
            "/api/preliminary-costs",
            headers=HEAD,
            json={"name": "Мой расчёт", "data": sample_draft()},
        )
        self.assertEqual(created.status_code, 201, created.text)
        record_id = created.json()["id"]

        self.login(self.other, "other", "Other-Password-2026!")
        self.assertEqual(
            self.other.get("/api/preliminary-costs", headers=HEAD).json()["items"],
            [],
        )
        self.assertEqual(
            self.other.get(f"/api/preliminary-costs/{record_id}", headers=HEAD).status_code,
            404,
        )

        anonymous = TestClient(main.app)
        try:
            self.assertEqual(anonymous.get("/api/preliminary-costs").status_code, 401)
        finally:
            anonymous.close()


if __name__ == "__main__":
    unittest.main()
