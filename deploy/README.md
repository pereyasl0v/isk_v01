# VPS deployment: RealityHost 1 vCPU / 1 GB RAM / 10 GB NVMe

The home setup stays untouched. The VPS only **pulls** pre-built private images
from GitHub Container Registry and runs them behind Caddy with automatic HTTPS.

## 1. SSH access (Windows Git Bash)

Create a dedicated key locally and do not send the private key or password to anyone:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/isk_vps_ed25519 -C isk-vps
ssh root@84.21.191.28
```

On VPS (root):
```bash
adduser deploy
usermod -aG sudo deploy
```

On local Git Bash, authorize the **public** key through the existing root connection:

```bash
cat ~/.ssh/isk_vps_ed25519.pub | ssh root@84.21.191.28 \
  'install -d -o deploy -g deploy -m 700 /home/deploy/.ssh && \
   tee -a /home/deploy/.ssh/authorized_keys >/dev/null && \
   chown deploy:deploy /home/deploy/.ssh/authorized_keys && \
   chmod 600 /home/deploy/.ssh/authorized_keys'
ssh -i ~/.ssh/isk_vps_ed25519 deploy@84.21.191.28
```

Confirm `sudo -v` works before disabling root/password login.

## 2. Transfer VPS config

On Windows Git Bash, from project root:

```bash
git checkout feature/ozon-digitization
git pull --ff-only origin feature/ozon-digitization
scp -i ~/.ssh/isk_vps_ed25519 \
  deploy/{bootstrap-ubuntu.sh,compose.yaml,Caddyfile,env.vps.example,update.sh} \
  deploy@84.21.191.28:~/
```

On the VPS as deploy:

```bash
sudo bash ~/bootstrap-ubuntu.sh
sudo chown deploy:deploy /opt/isk
mv ~/compose.yaml ~/Caddyfile ~/update.sh /opt/isk/
cp ~/env.vps.example /opt/isk/.env
chmod 600 /opt/isk/.env
sudo install -d -o root -g 10001 -m 0711 /opt/isk/secrets
```

`/opt/isk/.env` defaults to `84.21.191.28.sslip.io`. This free DNS
name points to the VPS IP. Caddy requests an HTTPS certificate automatically.
For a different domain, set `ISK_DOMAIN` after its DNS points to VPS.

## 3. Keep existing encrypted data

**Do not generate a new encryption key when migrating an existing ISK.**
From your existing Windows Docker deployment, create a consistent SQLite copy:

```bash
docker compose exec -T isk python -c "import sqlite3; s=sqlite3.connect('/data/inventory.sqlite3'); d=sqlite3.connect('/data/isk_backup.sqlite3'); s.backup(d); d.close(); s.close()"
docker compose cp isk:/data/isk_backup.sqlite3 ./isk_backup.sqlite3
```

From that same project directory on Windows, transfer BOTH files over SSH:

```bash
scp -i ~/.ssh/isk_vps_ed25519 \
  ./isk_backup.sqlite3 ./secrets/isk_encryption_key \
  deploy@84.21.191.28:~/
```

On VPS (deploy), put the encryption key under root ownership while retaining
read access for the non-root container (UID/GID 10001):

```bash
sudo install -o root -g 10001 -m 0440 \
  ~/isk_encryption_key /opt/isk/secrets/isk_encryption_key
rm ~/isk_encryption_key
sudo chown root:10001 ~/isk_backup.sqlite3
sudo chmod 0640 ~/isk_backup.sqlite3
```

**Before the first app start**, restore SQLite into the persistent Docker volume
as the application's UID:

```bash
cd /opt/isk
sudo docker compose pull isk
sudo docker compose run --rm --no-deps \
  -v /home/deploy/isk_backup.sqlite3:/restore.sqlite3:ro \
  --entrypoint python isk \
  -c 'import sqlite3; s=sqlite3.connect("/restore.sqlite3"); d=sqlite3.connect("/data/inventory.sqlite3"); s.backup(d); d.close(); s.close()'
sudo docker compose up -d --wait
sudo docker compose ps
```

Verify the HTTPS website and your existing login, then securely archive/remove
`~/isk_backup.sqlite3`. Keep an offline copy of BOTH the database and key.
Never run `docker compose down -v`.

If this is a **fresh** installation, instead create a new key once in
`/opt/isk/secrets/isk_encryption_key`, start the stack, and create an admin:
`sudo docker compose exec isk python -m backend.admin create-admin --username admin`.
Do not follow this fresh-install route when preserving existing data.

## 4. Private GHCR authentication

In GitHub Settings > Developer settings > Personal access tokens > Tokens
(classic), issue a short-lived token with `read:packages`. GitHub package
access must also allow that account. Keep image private. On VPS, as deploy:

```bash
read -rsp 'GitHub package token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io -u pereyasl0v --password-stdin
unset GHCR_TOKEN
```

Authenticate **before** `docker compose pull isk` in step 3.

Every successful GitHub push to `feature/ozon-digitization` after backend,
frontend and Docker tests publishes `ghcr.io/pereyasl0v/isk_v01:stable`.
Wait for the GitHub Actions `publish` job to succeed before pulling.

## 5. One-command updates (no VPS builds)

On VPS:

```bash
sudo sh /opt/isk/update.sh
```

From Windows Git Bash (interactive sudo prompt):

```bash
ssh -t -i ~/.ssh/isk_vps_ed25519 deploy@84.21.191.28 \
  'sudo sh /opt/isk/update.sh'
```

The script pulls the current stable image, updates containers, waits for the
app healthcheck and prunes unused image layers. Named SQLite and TLS volumes
are retained.

## 6. Verify HTTPS and secure SSH

Open: **https://84.21.191.28.sslip.io**

If certificate issuance fails, check the domain resolves to your VPS, ports
80 and 443 are permitted by the provider firewall, then:

```bash
cd /opt/isk
sudo docker compose ps
sudo docker compose logs --tail=80 caddy
sudo docker compose logs --tail=80 isk
```

Only **after** a separate terminal successfully connects as `deploy` with
your SSH key and `sudo -v` works, disable password and root SSH login:

```bash
sudo tee /etc/ssh/sshd_config.d/01-isk-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -E 'permitrootlogin|passwordauthentication|kbdinteractiveauthentication'
```

Keep the current SSH session open and verify **another** SSH key login before
closing it. Do not expose Docker TCP socket or port 8000 publicly. On a 10 GB
disk, monitor `df -h` and SQLite size; 1 GB RAM may limit processing large
Ozon reports. Avoid placing passwords or the encryption key in GitHub, CI logs,
or support chats.


## 7. Automated GitHub Actions → VPS with safe deferred updates

After the backend/frontend/Docker checks and GHCR publish finish, GitHub
Actions can SSH into the VPS and **queue** the release. A root-owned systemd
timer checks the pending flag every minute. It pulls a new image and restarts
the app **only when there is no active Ozon job**. If digitization is waiting
through HTTP 429, the release stays queued, even for hours. Neither the queue
nor the deployment agent removes SQLite/TLS Docker volumes.

**First update the VPS manually when all Ozon tasks are idle**, so the running
container has the new private `/data/.isk_active_job` marker. Do not enable
the auto-deploy queue while an older application build is running a job.

### One-time installation on VPS

On your trusted Windows Git Bash computer, in this repository:
```bash
git checkout feature/ozon-digitization
git pull --ff-only origin feature/ozon-digitization
scp -i ~/.ssh/isk_vps_ed25519 \
  deploy/{auto-update.sh,request-update.sh,install-auto-deploy.sh,isk-auto-update.service,isk-auto-update.timer} \
  deploy@84.21.191.28:/home/deploy/
```

On VPS, **after** the manual update and while the application is idle:
```bash
sudo bash /home/deploy/install-auto-deploy.sh
sudo systemctl list-timers isk-auto-update.timer --no-pager
```

Installation makes the scripts root-owned and executable at
`/usr/local/sbin/isk-auto-update` and `/usr/local/sbin/isk-request-update`.
The `deploy` Linux user receives passwordless sudo permission **only for**
`/usr/local/sbin/isk-request-update`, which accepts no arguments and cannot
execute user-supplied commands. It creates a private queued-deployment flag.

### Dedicated forced-command SSH key

**Never reuse the normal VPS administration SSH key for GitHub Actions.**
On Windows Git Bash:
```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/isk_actions_deploy -C github-actions-isk
PUB="$(cat ~/.ssh/isk_actions_deploy.pub)"
ssh -i ~/.ssh/isk_vps_ed25519 deploy@84.21.191.28 \
  "umask 077; mkdir -p ~/.ssh; printf '%s\n' 'restrict,command=\"sudo -n /usr/local/sbin/isk-request-update\" $PUB' >> ~/.ssh/authorized_keys"
```

The `restrict,command=...` SSH entry allows this key only to queue an update:
no interactive shell, TCP forwarding, or arbitrary sudo. Keep the existing
ordinary SSH key for troubleshooting.

Verify the SSH server's real **host key fingerprint** before pinning it:
```bash
ssh-keyscan -t ed25519 84.21.191.28 > isk_host_keys
ssh-keygen -lf isk_host_keys
ssh -i ~/.ssh/isk_vps_ed25519 deploy@84.21.191.28 \
  'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
```
The SHA256 fingerprints must match. **Do not proceed** if they differ.

Set three repository **Actions secrets** at GitHub →
`pereyasl0v/isk_v01` → Settings → Secrets and variables → Actions:
- `ISK_DEPLOY_SSH_KEY`: complete contents of `~/.ssh/isk_actions_deploy`
  (private key, including BEGIN/END lines). Paste into GitHub secret UI only,
  never a chat message or committed file.
- `ISK_DEPLOY_KNOWN_HOSTS`: complete line from `isk_host_keys`, including
  `84.21.191.28 ssh-ed25519 ...`.
- `ISK_DEPLOY_HOST`: `84.21.191.28`.

If these secrets are not yet configured, the deploy job reports that
auto-deploy is unconfigured and skips SSH. The normal pipeline still builds
and publishes the Docker image.

After the next successful push on `feature/ozon-digitization`, GitHub's
**Queue safe VPS update** job connects by pinned SSH, queues the update and
exits. The systemd timer later applies the image once ISK becomes idle.

### Operations and verification

```bash
sudo systemctl list-timers isk-auto-update.timer --no-pager
sudo journalctl -u isk-auto-update.service -n 50 --no-pager
sudo docker compose -f /opt/isk/compose.yaml ps
sudo test -e /var/lib/isk-deploy/pending && echo "Queued" || echo "No queued update"
```

A new Ozon task is briefly refused during the actual version switch;
existing running tasks are protected. A server/container crash cannot
guarantee completion of an interrupted Ozon job; saved SQLite days remain.
If an update fails, its pending flag remains for the next timer run.
To temporarily pause auto-deployment, run
`sudo systemctl stop isk-auto-update.timer`; re-enable with
`sudo systemctl start isk-auto-update.timer`.

Do not delete `/opt/isk/secrets`, `/opt/isk/.env` or Docker named volumes.
