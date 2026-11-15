import argparse
import getpass
import os
from pathlib import Path

from .security import hash_password, load_encryption_key, valid_username
from .storage import Store


def main():
    parser=argparse.ArgumentParser(description='Управление локальными администраторами ИСК')
    sub=parser.add_subparsers(dest='command',required=True)
    create=sub.add_parser('create-admin',help='Создать первого администратора')
    create.add_argument('--username',default='admin')
    args=parser.parse_args()
    if not valid_username(args.username):
        raise SystemExit('Логин должен содержать 3–32 символа: латиница, цифры, точка, дефис или подчёркивание.')

    data=Path(os.environ.get('OZON_FBO_DATA_DIR',str(Path(os.environ.get('LOCALAPPDATA',str(Path.home()))) / 'VKR_Ozon_FBO_Web')))
    data.mkdir(parents=True,exist_ok=True)
    key=load_encryption_key()
    if not key:
        raise SystemExit('Не найден ключ шифрования. Сначала создайте secrets/isk_encryption_key и запустите контейнер.')
    store=Store(data/'inventory.sqlite3',encryption_key=key)
    if store.count_active_admins():
        raise SystemExit('Активный администратор уже существует. Новых пользователей создавайте из интерфейса ИСК.')
    password=getpass.getpass('Пароль администратора (не менее 12 символов): ')
    confirm=getpass.getpass('Повторите пароль: ')
    if password!=confirm:
        raise SystemExit('Пароли не совпадают.')
    try:encoded=hash_password(password)
    except ValueError as exc:raise SystemExit(str(exc)) from None
    try:user=store.create_user(args.username,encoded,'admin')
    except Exception as exc:raise SystemExit('Не удалось создать администратора: '+str(exc)) from None
    print('Администратор создан: '+user['username'])
    print('Сохраните пароль в менеджере паролей. Он не хранится в открытом виде.')


if __name__=='__main__':
    main()
