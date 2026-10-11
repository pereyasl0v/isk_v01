# Архитектура ИСК 0.1

React → FastAPI (loopback) → Ozon Seller API. SQLite хранит снимки по кабинету и типу данных. Ключи только в памяти процесса.

- backend/legacy.py — информационный транспорт, пагинация каталога и исходных остатков.
- backend/ozon.py — аналитика остатков, история FBO со складом отгрузки.
- backend/storage.py — транзакционные снимки JSON в SQLite.
- backend/inventory.py — показатели остатков и группировка.
- backend/replenishment.py — два уровня прогноза: SKU/склад и общий SKU.
- backend/main.py — сессии, фоновые задания, API, раздача SPA.
- frontend/src/Replenishment.jsx — единый раздел с выбором периода и уровня.
- frontend/src/main.jsx — остальные разделы и маршруты.

POST /api/replenishment принимает window: 7, 14, 30 или 90. Возвращает даты периода, предупреждения и items по SKU; в каждом total и warehouses. Старые /api/plan и /api/forecast удалены. Нормализация базы для окончательной ER-модели ВКР остаётся отдельным этапом.
