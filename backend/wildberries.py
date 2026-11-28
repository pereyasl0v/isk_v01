"""Small, read-only client for validating Wildberries FBW Supplies API credentials.

The seller portal's private browser endpoints are intentionally not used here.
"""
from uuid import UUID

import httpx


SUPPLIES_API = "https://supplies-api.wildberries.ru"
COMMON_API = "https://common-api.wildberries.ru"


class WildberriesApiError(Exception):
    """Safe, user-facing Wildberries API error."""


class Wildberries:
    def __init__(self, api_token: str):
        self.api_token = str(api_token or "").strip()

    def _get(self, url, forbidden_message, response_type=dict):
        if not self.api_token:
            raise WildberriesApiError("Введите API-токен Wildberries.")
        try:
            response = httpx.get(
                url,
                headers={"Authorization": self.api_token},
                timeout=10.0,
                follow_redirects=False,
            )
        except httpx.TimeoutException:
            raise WildberriesApiError("Wildberries не ответил за 10 секунд. Повторите проверку.") from None
        except httpx.RequestError:
            raise WildberriesApiError("Не удалось связаться с API Wildberries.") from None

        if response.status_code == 200:
            try:
                payload = response.json()
            except ValueError:
                raise WildberriesApiError("API Wildberries вернул некорректный ответ.") from None
            if isinstance(payload, response_type):
                return payload
            raise WildberriesApiError("API Wildberries вернул некорректный ответ.")

        if response.status_code == 401:
            raise WildberriesApiError("Wildberries отклонил токен. Проверьте, что это действующий API-токен.")
        if response.status_code == 403:
            raise WildberriesApiError(forbidden_message)
        if response.status_code == 429:
            raise WildberriesApiError("Wildberries временно ограничил проверку токена. Повторите позже.")
        raise WildberriesApiError(f"Не удалось проверить токен Wildberries (HTTP {response.status_code}).")


    def ping_supplies(self):
        payload = self._get(
            f"{SUPPLIES_API}/ping",
            "Токен не имеет доступа к API Поставок. Создайте токен WB с категорией «Поставки».",
        )
        if str(payload.get("Status", "")).upper() != "OK":
            raise WildberriesApiError("Wildberries не подтвердил доступ к API Поставок.")
        return {"status": "OK", "checked_at": payload.get("TS")}

    def seller_sid(self):
        payload = self._get(
            f"{COMMON_API}/api/v1/seller-info",
            "Токен WB не позволяет получить идентификатор продавца (SID).",
        )
        try:
            return str(UUID(payload.get("sid", "")))
        except (ValueError, TypeError, AttributeError):
            raise WildberriesApiError("Wildberries не вернул корректный SID продавца.") from None

    def acceptance_coefficients(self):
        return self._get(
            f"{COMMON_API}/api/tariffs/v1/acceptance/coefficients",
            "Токен WB не даёт доступа к коэффициентам приёмки. Проверьте права токена в кабинете WB.",
            list,
        )
