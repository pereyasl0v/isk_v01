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
from backend.storage import Store
from backend.security import hash_password

HEAD = {"Origin": "http://127.0.0.1:8000"}
ADMIN_PASSWORD = "Admin-Password-2026!"
OTHER_PASSWORD = "Other-Password-2026!"


def label_body(name="Щипцы СВП", code="2053809942215"):
    values = {
        "productName": name,
        "article": "SKU-100",
        "brand": "Тестовый бренд",
        "importer": "Импортер с конфиденциальными реквизитами",
    }
    return {
        "name": name,
        "code": code,
        "data": {
            "values": values,
            "enabled": {"productName": True, "article": True, "brand": True, "importer": True},
            "barcodeEnabled": True,
            "sizeKey": "58x40",
            "textSize": 1.76,
            "showEac": False,
            "showRst": False,
        },
    }


class BarcodeArchiveApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        main.store = Store(Path(self.tmp.name) / "db.sqlite", encryption_key=main.ENCRYPTION_KEY)
        main.runtime_accounts.clear()
        main.store.create_user("admin", hash_password(ADMIN_PASSWORD), "admin")
        main.store.create_user("other", hash_password(OTHER_PASSWORD), "user")
        self.client = TestClient(main.app)
        self.other = TestClient(main.app)
        self.login(self.client, "admin", ADMIN_PASSWORD)

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

    def test_archive_create_search_edit_and_delete(self):
        created = self.client.post("/api/barcodes", headers=HEAD, json=label_body())
        self.assertEqual(created.status_code, 201, created.text)
        item = created.json()
        self.assertEqual(item["name"], "Щипцы СВП")
        self.assertEqual(item["code"], "2053809942215")
        self.assertIn("data", item)

        found = self.client.get("/api/barcodes?q=%D1%89%D0%B8%D0%BF", headers=HEAD)
        self.assertEqual(found.status_code, 200, found.text)
        self.assertEqual([row["id"] for row in found.json()["items"]], [item["id"]])

        detail = self.client.get(f"/api/barcodes/{item['id']}", headers=HEAD)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["data"]["values"]["article"], "SKU-100")

        updated_body = label_body("Кусачки СВП обновлённые")
        updated_body["data"]["values"]["article"] = "SKU-200"
        updated = self.client.put(
            f"/api/barcodes/{item['id']}", headers=HEAD, json=updated_body
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["data"]["values"]["article"], "SKU-200")
        self.assertEqual(updated.json()["created_at"], item["created_at"])

        self.assertEqual(
            self.client.get("/api/barcodes?q=Щипцы%20СВП", headers=HEAD).json()["items"],
            [],
        )
        self.assertEqual(
            len(self.client.get("/api/barcodes?q=Кусачки", headers=HEAD).json()["items"]),
            1,
        )

        with main.store.db() as db:
            row = db.execute(
                "SELECT payload FROM barcode_labels WHERE id=?", (item["id"],)
            ).fetchone()
        self.assertNotIn("конфиденциальными реквизитами", row[0])

        deleted = self.client.delete(f"/api/barcodes/{item['id']}", headers=HEAD)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(
            self.client.get("/api/barcodes", headers=HEAD).json()["items"],
            [],
        )
        self.assertEqual(
            self.client.get(f"/api/barcodes/{item['id']}", headers=HEAD).status_code,
            404,
        )

    def test_archive_is_private_to_each_user_and_does_not_require_ozon(self):
        created = self.client.post("/api/barcodes", headers=HEAD, json=label_body())
        self.assertEqual(created.status_code, 201, created.text)
        label_id = created.json()["id"]

        self.login(self.other, "other", OTHER_PASSWORD)
        self.assertEqual(self.other.get("/api/barcodes", headers=HEAD).json()["items"], [])
        self.assertEqual(
            self.other.get(f"/api/barcodes/{label_id}", headers=HEAD).status_code,
            404,
        )
        self.assertEqual(
            self.other.delete(f"/api/barcodes/{label_id}", headers=HEAD).status_code,
            404,
        )

    def test_rejects_invalid_ean13(self):
        invalid = label_body(code="2053809942214")
        response = self.client.post("/api/barcodes", headers=HEAD, json=invalid)
        self.assertEqual(response.status_code, 422, response.text)

    def test_requires_authentication(self):
        anonymous = TestClient(main.app)
        try:
            self.assertEqual(anonymous.get("/api/barcodes").status_code, 401)
            self.assertEqual(
                anonymous.post("/api/barcodes", headers=HEAD, json=label_body()).status_code,
                401,
            )
        finally:
            anonymous.close()


if __name__ == "__main__":
    unittest.main()
