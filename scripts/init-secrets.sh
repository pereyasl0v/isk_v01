#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root: sudo sh scripts/init-secrets.sh" >&2
  exit 1
fi
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SECRET_DIR="$ROOT/secrets"
SECRET_FILE="$SECRET_DIR/isk_encryption_key"
umask 077
mkdir -p "$SECRET_DIR"
if [ -e "$SECRET_FILE" ]; then
  echo "Ключ уже существует: $SECRET_FILE"
  echo "Не перегенерируйте его: без прежнего ключа нельзя расшифровать данные."
  exit 0
fi
python3 -c 'import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())' > "$SECRET_FILE"
chown root:10001 "$SECRET_DIR" "$SECRET_FILE"
chmod 0750 "$SECRET_DIR"
chmod 0440 "$SECRET_FILE"
echo "Создан ключ шифрования: $SECRET_FILE (root:10001, 0440)"
echo "Сделайте защищённую резервную копию ключа вне VPS и вне Git."
