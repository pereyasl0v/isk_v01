"""Small, read-only client for validating Wildberries FBW Supplies API credentials.

The seller portal's private browser endpoints are intentionally not used here.
"""
import httpx


SUPPLIES_API = "https://supplies-api.wildberries.ru"


class WildberriesApiError(Exception):
    """Safe, user-facing Wildberries API error."""


class Wildberries:
    def __init__(self, api_token: str):
        self.api_token = str(api_token or "").strip()

    def ping_supplies(self):
        if not self.api_token:
            raise WildberriesApiError("Введите API-токен Wildberries.")
        try:
            response = httpx.get(
                f"{SUPPLIES_API}/ping",
                headers={"Authorization": self.api_token},
                timeout=10.0,
                follow_redirects=False,
            )
        except httpx.TimeoutException:
            raise WildberriesApiError("Wildberries не ответил за 10 секунд. Повторите проверку.") from None
        except httpx.RequestError:
            raise WildberriesApiError("Не удалось связаться с API Поставок Wildberries.") from None

        if response.status_code == 200:
            try:
                payload = response.json()
            except ValueError:
                raise WildberriesApiError("API Wildberries вернул некорректный ответ.") from None
            if str(payload.get("Status", "")).upper() == "OK":
                return {"status": "OK", "checked_at": payload.get("TS")}
            raise WildberriesApiError("Wildberries не подтвердил доступ к API Поставок.")

        if response.status_code == 401:
            raise WildberriesApiError("Wildberries отклонил токен. Проверьте, что это действующий API-токен.")
        if response.status_code == 403:
            raise WildberriesApiError("Токен не имеет доступа к API Поставок. Создайте токен WB с категорией «Поставки».")
        if response.status_code == 429:
            raise WildberriesApiError("Wildberries временно ограничил проверку токена. Повторите позже.")
        raise WildberriesApiError(f"Не удалось проверить токен Wildberries (HTTP {response.status_code}).")
