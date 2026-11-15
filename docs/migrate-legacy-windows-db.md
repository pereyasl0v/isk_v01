# Перенос старой Windows-базы Ozon в Docker

Инструкция предназначена для локальной разработки на Windows (Git Bash). Старую базу и резервную копию не удалять.

## Перед началом

1. Убедитесь, что создана резервная копия через SQLite Backup API.
2. Убедитесь, что файл ключа `secrets/isk_encryption_key` сохранён. Не создавайте новый ключ, если база Docker уже содержит зашифрованные данные.
3. Обновите проект и пересоберите контейнер:

```bash
git pull --ff-only origin feature/ozon-digitization
docker compose up -d --build
```

## Скопировать резервную копию во временный каталог контейнера

Подставьте имя фактически созданной резервной копии. Пример для файла от 15 ноября 2026 года:

```bash
LEGACY_BACKUP="$LOCALAPPDATA/VKR_Ozon_FBO_Web/inventory.before_isk_migration_20261115_141651.sqlite3"
CONTAINER="$(docker compose ps -q isk)"
MSYS_NO_PATHCONV=1 docker cp "$(cygpath -w "$LEGACY_BACKUP")" "$CONTAINER:/tmp/isk-legacy.sqlite3"
```

Копия помещается во временную файловую систему контейнера `/tmp`; в Git она не попадает. Размер файла должен помещаться в лимит tmpfs, заданный в `docker-compose.yml`.

## Запустить импорт

Укажите логин администратора, которому принадлежит подключённый кабинет Ozon:

```bash
docker compose exec isk python -m backend.import_legacy --source /tmp/isk-legacy.sqlite3 --username admin
```

Импортёр:
- открывает исходную резервную копию только для чтения;
- проверяет структуру, единый Client ID и совпадение с кабинетом выбранного администратора;
- переносит снимки, API-кэш, периоды и дни оцифровки в пространство существующего кабинета;
- шифрует JSON-payload новым ключом ИСК;
- сохраняет более свежие записи при конфликте ключей API-кэша и периодов;
- выполняет запись и регистрацию импорта в одной транзакции;
- отказывается повторно импортировать уже обработанную базу в этот кабинет.

Успешный результат должен содержать `Статус: imported`, Client ID `5486923` и количества строк исходной базы. При повторном запуске той же копии будет выведено `already_imported`, без создания дубликатов.

## Проверить результат

```bash
docker compose exec isk python -c 'import sqlite3; c=sqlite3.connect("/data/inventory.sqlite3"); a=c.execute("SELECT id FROM ozon_accounts WHERE client_id=? AND connected=1",("5486923",)).fetchone(); assert a, "Кабинет не найден"; scope="account:"+a[0]; print("account:",a[0]); [(print(t,c.execute("SELECT COUNT(*) FROM "+t+" WHERE client=?",(scope,)).fetchone()[0])) for t in ("snapshots","api_cache","digitization_periods","digitization_days")]; print("import:",c.execute("SELECT imported_at,counts_json FROM legacy_database_imports WHERE account_id=?",(a[0],)).fetchone())'
```

Ожидается, что исходные 55 снимков, 565 cache-записей, 9 периодов и 97 дней будут доступны в пространстве этого кабинета. Число снимков будет больше 55, поскольку два новых снимка, созданных в Docker, сохраняются. Количество cache-записей может отличаться, если в Docker уже были более свежие значения с теми же ключами.

После успешной проверки удалите только временную копию из контейнера:

```bash
docker compose exec isk rm -f /tmp/isk-legacy.sqlite3
```

Оригинальная Windows-база и резервная копия остаются на компьютере без изменений.
