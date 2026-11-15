#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SECRET_DIR="$ROOT/secrets"
SECRET_FILE="$SECRET_DIR/isk_encryption_key"
mkdir -p "$SECRET_DIR"
if [ -e "$SECRET_FILE" ]; then
  echo "Ключ уже существует: $SECRET_FILE"
  echo "Не перегенерируйте его: без прежнего ключа нельзя расшифровать данные."
  exit 0
fi
umask 077
python3 -c 'import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())' > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
echo "Создан ключ шифрования: $SECRET_FILE"
echo "Сделайте его резервную копию в защищённом хранилище вне VPS и вне Git."
