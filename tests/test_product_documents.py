"""Product-card notes, encrypted documents, and account isolation."""
import base64
import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest.mock import patch

os.environ.setdefault(
    "ISK_ENCRYPTION_KEY",
    base64.urlsafe_b64encode(b"isk-test-key-32-bytes-0123456789").decode("ascii"),
)
from fastapi.testclient import TestClient
from backend import main
from backend.security import hash_password
from backend.storage import Store

ORIGIN = {"Origin": "http://127.0.0.1:8000"}
ADMIN_PASS = "TestAdminPassword2026!"
SELLER_PASS = "TestSellerPassword2026!"


class FakeOzon:
    def __init__(self, client_id, api_key, **kwargs):
        self.client_id = client_id

    def roles(self):
        return {"roles": [{"name": "Read only"}], "expires_at": "2027-02-01T00:00:00Z"}


class ProductDocumentsApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        main.store = Store(Path(self.temp.name) / "db.sqlite", encryption_key=main.ENCRYPTION_KEY)
        main.runtime_accounts.clear()
        main.store.create_user("admin", hash_password(ADMIN_PASS), role="admin")
        self.mock = patch.object(main, "Ozon", FakeOzon)
        self.mock.start()
        self.client = TestClient(main.app)
        self.login(self.client, "admin", ADMIN_PASS)
        self.account = self.connect(self.client, "123")
        self.scope = "account:" + self.account["account_id"]
        main.store.save(self.scope, "inventory", {
            "products": [{"id": 1, "sku": 100, "offer_id": "A", "name": "Пробный товар"}],
            "stocks": [], "analytics": [],
        })

    def tearDown(self):
        self.client.close()
        self.mock.stop()
        self.temp.cleanup()

    def login(self, client, username, password):
        response = client.post(
            "/api/auth/login", json={"username": username, "password": password}, headers=ORIGIN
        )
        self.assertEqual(response.status_code, 200, response.text)

    def connect(self, client, client_id):
        response = client.post(
            "/api/connect",
            json={"client_id": client_id, "api_key": "test-secret-key-abcdefghijkl"},
            headers=ORIGIN,
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def upload(self, client, name, data, path="/api/products/1/documents"):
        return client.post(
            path, content=data,
            headers={
                **ORIGIN,
                "Content-Type": "application/octet-stream",
                "X-File-Name": quote(name, safe=""),
            },
        )

    def test_note_and_file_survive_restart_and_are_encrypted(self):
        self.assertEqual(
            self.client.get("/api/products/1/details").json(),
            {"description": "", "documents": []},
        )
        note = "Сертификат ГОСТ, партия № 135."
        saved = self.client.put(
            "/api/products/1/details", headers=ORIGIN, json={"description": note}
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue(saved.json()["saved"])
        binary = b"%PDF-1.7\nTEST PRIVATE CERTIFICATE CONTENT\n%%EOF"
        response = self.upload(self.client, "Сертификат.pdf", binary)
        self.assertEqual(response.status_code, 201, response.text)
        doc = response.json()
        self.assertEqual(doc["name"], "Сертификат.pdf")
        self.assertEqual(doc["size"], len(binary))
        with main.store.db() as db:
            saved_doc = db.execute(
                "SELECT ciphertext FROM product_documents WHERE id=?", (doc["id"],)
            ).fetchone()[0]
            saved_notes = db.execute(
                "SELECT payload FROM product_notes WHERE product_id='1'"
            ).fetchone()[0]
        self.assertNotIn(binary, saved_doc)
        self.assertNotIn(b"TEST PRIVATE", saved_doc)
        self.assertTrue(saved_notes.startswith("enc:v1:"))
        self.assertNotIn(note, saved_notes)

        # Database storage remains readable across Store and process recreation.
        main.store = Store(Path(self.temp.name) / "db.sqlite", encryption_key=main.ENCRYPTION_KEY)
        main.runtime_accounts.clear()
        details = self.client.get("/api/products/1/details")
        self.assertEqual(details.status_code, 200, details.text)
        self.assertEqual(details.json()["description"], note)
        self.assertEqual(len(details.json()["documents"]), 1)
        downloaded = self.client.get("/api/products/1/documents/" + doc["id"])
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content, binary)
        self.assertIn("attachment;", downloaded.headers["content-disposition"])
        self.assertEqual(downloaded.headers["content-type"], "application/octet-stream")
        deleted = self.client.delete(
            "/api/products/1/documents/" + doc["id"], headers=ORIGIN
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(self.client.get("/api/products/1/details").json()["documents"], [])
        self.assertEqual(
            self.client.get("/api/products/1/documents/" + doc["id"]).status_code, 404
        )

    def test_account_isolation_and_missing_products(self):
        doc = self.upload(self.client, "private.pdf", b"%PDF-private").json()
        main.store.create_user("seller", hash_password(SELLER_PASS), role="user")
        other = TestClient(main.app)
        try:
            self.login(other, "seller", SELLER_PASS)
            second = self.connect(other, "123")
            scope2 = "account:" + second["account_id"]
            main.store.save(scope2, "inventory", {
                "products": [{"id": 1, "sku": 100, "offer_id": "A", "name": "Same id"}],
                "stocks": [], "analytics": [],
            })
            details = other.get("/api/products/1/details")
            self.assertEqual(details.status_code, 200, details.text)
            self.assertEqual(details.json()["documents"], [])
            self.assertEqual(
                other.get("/api/products/1/documents/" + doc["id"]).status_code, 404
            )
            self.assertEqual(
                other.delete("/api/products/1/documents/" + doc["id"], headers=ORIGIN).status_code,
                404,
            )
            self.assertEqual(other.get("/api/products/9/details").status_code, 404)
            self.assertEqual(other.get("/api/products/../../documents/1").status_code, 404)
        finally:
            other.close()

    def test_validation_auth_and_csrf(self):
        unauthenticated = TestClient(main.app)
        try:
            self.assertEqual(
                unauthenticated.get("/api/products/1/details").status_code, 401
            )
            self.assertEqual(
                self.upload(unauthenticated, "secret.pdf", b"secret").status_code, 401
            )
        finally:
            unauthenticated.close()

        self.assertEqual(
            self.client.post(
                "/api/products/1/documents", content=b"test",
                headers={"Content-Type": "application/octet-stream", "X-File-Name": "a.pdf"},
            ).status_code, 403,
        )
        self.assertEqual(self.upload(self.client, "evil.exe", b"NO").status_code, 422)
        self.assertEqual(self.upload(self.client, "blank.pdf", b"").status_code, 422)
        self.assertEqual(
            self.upload(self.client, "huge.pdf", b"1" * (15 * 1024 * 1024 + 1)).status_code,
            413,
        )
        self.assertEqual(
            self.client.put(
                "/api/products/1/details", headers=ORIGIN,
                json={"description": "x" * 4001},
            ).status_code,
            422,
        )
        self.assertEqual(self.client.put("/api/products/2/details", headers=ORIGIN,
                                         json={"description": "unknown"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
