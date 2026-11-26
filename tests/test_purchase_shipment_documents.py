"""Encrypted attachments for purchase shipments and user isolation."""
import base64
import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

os.environ.setdefault(
    "ISK_ENCRYPTION_KEY",
    base64.urlsafe_b64encode(b"isk-test-key-32-bytes-0123456789").decode("ascii"),
)
from fastapi.testclient import TestClient
from backend import main
from backend.security import hash_password
from backend.storage import Store

ORIGIN = {"Origin": "http://127.0.0.1:8000"}
PASSWORD = "TestShipmentDocsPassword2026!"


class PurchaseShipmentDocumentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        main.store = Store(Path(self.temp.name) / "db.sqlite", encryption_key=main.ENCRYPTION_KEY)
        main.runtime_accounts.clear()
        self.user_id = main.store.create_user("shipment-admin", hash_password(PASSWORD), role="admin")["id"]
        self.client = TestClient(main.app)
        login = self.client.post(
            "/api/auth/login",
            json={"username": "shipment-admin", "password": PASSWORD},
            headers=ORIGIN,
        )
        self.assertEqual(login.status_code, 200, login.text)
        main.store.save_preliminary_cost(
            self.user_id,
            None,
            "Поставка для теста",
            {"selectedRoute": "route1", "products": []},
            shipment={
                "id": "shipment-test-1",
                "calculated": {"summary": {"route1": {"totalQuantity": 1, "totalRub": 100}}},
            },
        )
        self.path = "/api/purchase-shipments/shipment-test-1/documents"

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def upload(self, name, content, path=None):
        return self.client.post(
            path or self.path,
            content=content,
            headers={
                **ORIGIN,
                "Content-Type": "application/octet-stream",
                "X-File-Name": quote(name, safe=""),
            },
        )

    def test_upload_list_download_delete_and_encrypted_persistence(self):
        self.assertEqual(self.client.get(self.path).json(), {"documents": []})
        raw = b"%PDF-1.7\nPRIVATE INVOICE CONTENT\n%%EOF"
        response = self.upload("Накладная.pdf", raw)
        self.assertEqual(response.status_code, 201, response.text)
        document = response.json()
        self.assertEqual(document["name"], "Накладная.pdf")
        self.assertEqual(document["size"], len(raw))
        with main.store.db() as db:
            encrypted = db.execute(
                "SELECT ciphertext FROM purchase_shipment_documents WHERE id=?",
                (document["id"],),
            ).fetchone()[0]
        self.assertNotIn(raw, encrypted)
        self.assertNotIn(b"PRIVATE INVOICE", encrypted)
        self.assertEqual(len(self.client.get(self.path).json()["documents"]), 1)

        main.store = Store(Path(self.temp.name) / "db.sqlite", encryption_key=main.ENCRYPTION_KEY)
        downloaded = self.client.get(self.path + "/" + document["id"])
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, raw)
        self.assertIn("attachment;", downloaded.headers["content-disposition"])

        deleted = self.client.delete(self.path + "/" + document["id"], headers=ORIGIN)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(self.client.get(self.path).json()["documents"], [])
        self.assertEqual(self.client.get(self.path + "/" + document["id"]).status_code, 404)

    def test_validation_and_shipment_isolation(self):
        self.assertEqual(self.upload("bad.exe", b"no").status_code, 422)
        self.assertEqual(self.upload("empty.pdf", b"").status_code, 422)
        self.assertEqual(
            self.upload("large.pdf", b"x" * (15 * 1024 * 1024 + 1)).status_code,
            413,
        )
        self.assertEqual(
            self.client.get("/api/purchase-shipments/missing/documents").status_code,
            404,
        )

        main.store.create_user("another-user", hash_password(PASSWORD), role="user")
        other = TestClient(main.app)
        try:
            login = other.post(
                "/api/auth/login",
                json={"username": "another-user", "password": PASSWORD},
                headers=ORIGIN,
            )
            self.assertEqual(login.status_code, 200, login.text)
            doc = self.upload("invoice.pdf", b"private").json()
            self.assertEqual(other.get(self.path).status_code, 404)
            self.assertEqual(other.get(self.path + "/" + doc["id"]).status_code, 404)
        finally:
            other.close()

    def test_unauthenticated_and_csrf_rejected(self):
        unauthenticated = TestClient(main.app)
        try:
            self.assertEqual(unauthenticated.get(self.path).status_code, 401)
            self.assertEqual(
                unauthenticated.post(
                    self.path,
                    content=b"private",
                    headers={"Content-Type": "application/octet-stream", "X-File-Name": "a.pdf"},
                ).status_code,
                403,
            )
        finally:
            unauthenticated.close()


if __name__ == "__main__":
    unittest.main()
