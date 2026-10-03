# Deploying on a Hostinger VPS

Self-hosted MongoDB, Nginx, PM2. No Docker. Built so that **projects 2 and 3
drop in later without touching anything already running.**

Target box: Ubuntu 24.04 LTS, 4 vCPU / 16 GB RAM / 200 GB NVMe.

---

## 0. The one thing that must not be got wrong

This app uses **MongoDB transactions** — 11 services call `withTransaction`
(fee collection, voiding, salary, rollover, stock sales…).

> **Transactions do not work on a standalone `mongod`.**
> Mongo must run as a **replica set**, even with a single node.

Install Mongo the ordinary way and every fee collection fails with
*"Transaction numbers are only allowed on a replica set member or mongos"*.
Section 4 sets this up correctly. Do not skip it.

---

## 1. Decide the shape first

Two options. **Option A is recommended** and this guide follows it.

### Option A — everything on the VPS, one origin (recommended)

```
https://school.yourdomain.com/          ->  React build, served by Nginx
https://school.yourdomain.com/api/v1/*  ->  Nginx proxy -> Node on 127.0.0.1:8001
```

Why this one:

- **One origin.** No CORS, no preflight, and the refresh cookie stays
  first-party — so `COOKIE_SAMESITE=lax` keeps working and Safari cannot break
  the login.
- **Fixes the Vercel licence problem.** Vercel's Hobby plan is
  non-commercial; this is a paying client. Moving the frontend here removes
  that question entirely.
- One box, one backup, one SSL certificate.

### Option B — frontend stays on Vercel

Then the backend answers on `api.yourdomain.com`, and in `Sps-frontend`:

```js
// deploy.config.js
export const API_PROD = 'https://api.yourdomain.com';
```

```bash
npm run sync:vercel   # writes it into vercel.json's /api rewrite
git commit -am "point api at the VPS" && git push
```

Vercel keeps proxying `/api/*` server-side, so it is still one origin to the
browser — `COOKIE_SAMESITE` stays `lax`. Set `FRONTEND_URL` on the VPS to your
Vercel domain. Everything else below is identical.

---

## 2. Before you start

| You need | Notes |
|---|---|
| VPS IP + root password | From the Hostinger panel |
| A domain | e.g. `yourdomain.com` |
| An SSH key on your Mac | `ls ~/.ssh/id_ed25519.pub` — if missing: `ssh-keygen -t ed25519` |

**DNS first** — it takes time to propagate, so do it now. In your domain's DNS:

| Type | Name | Value |
|---|---|---|
| A | `school` | `<your VPS IP>` |

Check it later with `dig +short school.yourdomain.com`.

---

## 3. Server setup and hardening

SSH in as root:

```bash
ssh root@<VPS_IP>
```

### 3.1 Update, set timezone

```bash
apt update && apt upgrade -y
timedatectl set-timezone Asia/Kolkata
```

Timezone matters less than you would think — every date boundary in this app
is computed in IST in code (`utils/istDate.js`), never from the server clock.
But logs being in IST makes support far easier.

### 3.2 A non-root user to run the apps

Running Node as root means a bug in any one of your three apps owns the whole
box. One extra step now, permanently safer.

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy

mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/ 2>/dev/null || true
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

If you have not put your key on the box yet, run this **on your Mac**:

```bash
ssh-copy-id deploy@<VPS_IP>
```

Now confirm from your Mac, in a **second terminal** (keep the root one open
until this works):

```bash
ssh deploy@<VPS_IP>
```

### 3.3 Lock down SSH

Only once key login works:

```bash
sudo sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

### 3.4 Firewall

Mongo is **never** exposed. Only SSH and web.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```

### 3.5 fail2ban and automatic security patches

```bash
sudo apt install -y fail2ban unattended-upgrades
sudo systemctl enable --now fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades   # choose Yes
```

### 3.6 Swap (safety net, not a substitute for RAM)

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
sudo sysctl -p /etc/sysctl.d/99-swap.conf
```

### 3.7 Raise file limits (Mongo wants this)

```bash
sudo tee /etc/security/limits.d/99-mongodb.conf >/dev/null <<'EOF'
*  soft  nofile  64000
*  hard  nofile  64000
*  soft  nproc   64000
*  hard  nproc   64000
EOF
```

---

## 4. MongoDB — as a single-node replica set

### 4.1 Install MongoDB 8.0

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc \
  | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

sudo apt update
sudo apt install -y mongodb-org
```

Pin the version so an `apt upgrade` never jumps a major release under you:

```bash
echo "mongodb-org hold" | sudo dpkg --set-selections
echo "mongodb-org-server hold" | sudo dpkg --set-selections
```

### 4.2 Config — replica set on, auth off (for now)

```bash
sudo tee /etc/mongod.conf >/dev/null <<'EOF'
storage:
  dbPath: /var/lib/mongodb
  wiredTiger:
    engineConfig:
      # Cap it. Default is (RAM/2 - 1GB) = ~7GB, which starves the three Node
      # apps and Nginx on a 16GB box. 4GB is plenty for a school's data.
      cacheSizeGB: 4
    collectionConfig:
      # zstd over the default snappy — noticeably smaller on disk for the
      # kind of repetitive documents a ledger produces. Must be set BEFORE
      # data exists; it only applies to collections created afterwards.
      blockCompressor: zstd

systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log

net:
  port: 27017
  # NEVER 0.0.0.0. Mongo stays unreachable from the internet; the apps talk
  # to it over loopback.
  bindIp: 127.0.0.1

replication:
  # Required for transactions. Single node is fine.
  replSetName: rs0

processManagement:
  timeZoneInfo: /usr/share/zoneinfo
EOF

sudo systemctl enable --now mongod
sudo systemctl status mongod --no-pager
```

### 4.3 Initiate the replica set

```bash
mongosh --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"127.0.0.1:27017"}]})'
```

Confirm it is PRIMARY (this is the check that matters):

```bash
mongosh --eval 'rs.status().members[0].stateStr'
# must print: PRIMARY
```

### 4.4 Create the users

```bash
mongosh
```

```js
use admin
db.createUser({
  user: "root_admin",
  pwd: "PUT_A_LONG_RANDOM_PASSWORD_HERE",
  roles: [{ role: "root", db: "admin" }]
})

use sps
db.createUser({
  user: "sps_app",
  pwd: "PUT_ANOTHER_LONG_RANDOM_PASSWORD_HERE",
  roles: [{ role: "readWrite", db: "sps" }]
})
exit
```

Generate the passwords on the box and keep them somewhere safe:

```bash
openssl rand -base64 32
```

> **Note the one-app-one-user rule.** When Solar4U lands, it gets its own
> `solar4u_app` user with `readWrite` on the `solar4u` database only. A shared
> user would mean a bug in one project can write to another project's data.

### 4.5 Turn auth on

A replica set with authorisation also needs an internal key file — even with
one member. This is the step people miss.

```bash
openssl rand -base64 756 | sudo tee /etc/mongod.keyfile >/dev/null
sudo chmod 400 /etc/mongod.keyfile
sudo chown mongodb:mongodb /etc/mongod.keyfile

sudo tee -a /etc/mongod.conf >/dev/null <<'EOF'

security:
  keyFile: /etc/mongod.keyfile
  authorization: enabled
EOF

sudo systemctl restart mongod
```

Verify auth is genuinely on — the first must fail, the second must work:

```bash
mongosh --quiet --eval 'db.adminCommand({listDatabases:1})'   # expect: not authorized
mongosh "mongodb://sps_app:YOUR_PASSWORD@127.0.0.1:27017/sps?authSource=sps" \
  --quiet --eval 'db.runCommand({ping:1})'                    # expect: { ok: 1 }
```

### 4.6 Log rotation

Mongo's log will otherwise grow without limit.

```bash
sudo tee /etc/logrotate.d/mongodb >/dev/null <<'EOF'
/var/log/mongodb/mongod.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 640 mongodb mongodb
    sharedscripts
    postrotate
        /bin/kill -SIGUSR1 $(cat /var/run/mongodb/mongod.pid 2>/dev/null) 2>/dev/null || true
    endscript
}
EOF
```

---

## 5. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

Node 22 is the LTS line. The app requires `>=18`.

---

## 6. The folder layout

This is the part that decides whether adding project 2 and 3 is easy or
painful. One directory per project, one port per project, one Nginx file per
project — nothing shared except the proxy snippet.

```
/srv/apps/                     the code
  ├── sps-backend/             <- git clone of this repo
  ├── sps-frontend/            <- git clone of the React repo
  ├── solar4u-backend/         (later)
  └── project3/                (later)

/srv/backups/                  database dumps
  ├── sps/
  └── solar4u/

/srv/logs/                     PM2 logs, rotated
```

```bash
sudo mkdir -p /srv/apps /srv/backups/sps /srv/logs
sudo chown -R deploy:deploy /srv
```

**Port register — keep this list updated as you add projects:**

| Project | Port | Mongo DB | PM2 name |
|---|---|---|---|
| SPS backend | 8001 | `sps` | `sps-api` |
| Solar4U backend | 8002 | `solar4u` | `solar4u-api` |
| Project 3 | 8003 | `project3` | `project3-api` |

---

## 7. Deploy the backend

### 7.1 Clone

As `deploy`:

```bash
cd /srv/apps
git clone <YOUR_BACKEND_GIT_URL> sps-backend
cd sps-backend
npm ci --omit=dev
```

`--omit=dev` skips `nodemon` — smaller install, nothing unused on disk.

> **Private repo?** Make a deploy key:
> ```bash
> ssh-keygen -t ed25519 -f ~/.ssh/sps_deploy -N ""
> cat ~/.ssh/sps_deploy.pub    # add to GitHub -> repo -> Settings -> Deploy keys
> ```
> Then add to `~/.ssh/config`:
> ```
> Host github-sps
>   HostName github.com
>   User git
>   IdentityFile ~/.ssh/sps_deploy
> ```
> and clone with `git clone git@github-sps:you/Sps-backend.git sps-backend`.
> A separate key per project means revoking one does not affect the others.

### 7.2 The `.env`

```bash
nano /srv/apps/sps-backend/.env
```

```ini
NODE_ENV=production
PORT=8001

# Local Mongo. authSource=sps because the user was created in that database.
MONGODB_URI=mongodb://sps_app:YOUR_PASSWORD@127.0.0.1:27017/sps?authSource=sps&replicaSet=rs0

# openssl rand -base64 48   — run it TWICE, these must differ
ACCESS_TOKEN_SECRET=
REFRESH_TOKEN_SECRET=
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d

# Option A (frontend on this VPS):
FRONTEND_URL=https://school.yourdomain.com
# Option B (frontend on Vercel): use your Vercel domain instead.

COOKIE_SAMESITE=lax

# Optional — leave blank and the app runs fine, the UI just hides the
# upload box. Set all three or none.
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_FOLDER=sps

BACKUP_KEEP=30
```

```bash
chmod 600 /srv/apps/sps-backend/.env
```

The app validates all of this at boot and refuses to start on a bad config —
including refusing two identical token secrets. If it starts, the config is
sound.

> If Mongo reports a topology error on first run, swap `replicaSet=rs0` for
> `directConnection=true` in the URI. Both work with a single node; the test
> suite uses the latter.

### 7.3 First-run bootstrap (once only)

Order matters.

```bash
cd /srv/apps/sps-backend

npm run seed:admin            # prints a temporary password — WRITE IT DOWN
npm run seed:session 2026-27  # session + classes
npm run build:indexes         # autoIndex is OFF in production, so this is required
```

`seed:admin` also seeds the default role permissions. The temporary password
must be changed at first login — the API refuses every other route until it is.

### 7.4 Smoke test it by hand

```bash
node server/index.js
# another terminal:
curl -s localhost:8001/health
```

Expect `{"success":true,...}`. `/health` sits *after* the database middleware,
so a 200 means Mongo is genuinely reachable. `Ctrl-C` when happy.

---

## 8. PM2

```bash
sudo npm install -g pm2
```

### 8.1 Ecosystem file

```bash
nano /srv/apps/sps-backend/ecosystem.config.js
```

```js
module.exports = {
    apps: [
        {
            name: 'sps-api',
            cwd: '/srv/apps/sps-backend',
            script: 'server/index.js',

            // ONE instance, deliberately.
            //
            // The app keeps small in-memory TTL caches (the logged-in user, the
            // permission map, the active session) and invalidates them the
            // moment an Admin changes something. In cluster mode only the
            // instance that handled the change clears its own cache — the other
            // would serve stale permissions for up to 60 seconds.
            //
            // A school with a handful of users does not need two processes, and
            // instant permission changes are worth more than headroom nobody
            // uses. Raise this only if the box is genuinely busy, and accept
            // the delay when you do.
            instances: 1,
            exec_mode: 'fork',

            env: { NODE_ENV: 'production' },

            max_memory_restart: '400M',
            error_file: '/srv/logs/sps-api.err.log',
            out_file: '/srv/logs/sps-api.out.log',
            merge_logs: true,
            time: true,
        },
    ],
};
```

### 8.2 Start, and survive reboots

```bash
cd /srv/apps/sps-backend
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy
# it prints one `sudo env ...` line — run exactly that
```

### 8.3 Log rotation (or logs will eat the disk)

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

Useful day to day:

```bash
pm2 list
pm2 logs sps-api --lines 100
pm2 reload sps-api      # zero-downtime restart
pm2 monit
```

---

## 9. Nginx

```bash
sudo apt install -y nginx
```

### 9.1 The shared proxy snippet — write once, reuse for every project

```bash
sudo tee /etc/nginx/snippets/node-proxy.conf >/dev/null <<'EOF'
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        "upgrade";
proxy_cache_bypass $http_upgrade;
proxy_read_timeout 60s;
proxy_connect_timeout 10s;
EOF
```

`X-Forwarded-For` matters: the app sets `trust proxy: 1`, so without this
header every request looks like it came from one IP and the login rate limiter
would lock out the whole school at once.

### 9.2 The SPS site

```bash
sudo nano /etc/nginx/sites-available/sps.conf
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name school.yourdomain.com;

    # The React build. Section 10 puts it here.
    root /srv/apps/sps-frontend/dist;
    index index.html;

    # The app caps request bodies at 256kb; images go straight to Cloudinary
    # from the browser and never pass through here.
    client_max_body_size 1m;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # Vite writes content-hashed filenames, so these can never go stale.
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8001;
        include snippets/node-proxy.conf;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8001;
        include snippets/node-proxy.conf;
        access_log off;
    }

    # SPA fallback — every other path is React Router's.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sps.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 9.3 HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d school.yourdomain.com
```

Choose redirect-to-HTTPS when asked. Certbot edits the file above and installs
a renewal timer. Check it:

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

---

## 10. The frontend on the same box

```bash
cd /srv/apps
git clone <YOUR_FRONTEND_GIT_URL> sps-frontend
cd sps-frontend
npm ci
```

`.env` — one line, and it must stay empty:

```bash
echo 'VITE_API_URL=' > .env
```

Empty means the browser calls `/api/v1/...` on its own origin, which Nginx
proxies to Node. That is what keeps the cookie first-party.

Build:

```bash
npx vite build
```

> Use `npx vite build`, **not** `npm run build`. The npm script runs
> `check:vercel` first, which fails the build if `vercel.json` disagrees with
> `deploy.config.js`. That guard exists for Vercel deploys and has no meaning
> here.

Nginx is already pointed at `dist/`. Reload and open the site:

```bash
sudo systemctl reload nginx
```

Log in as `admin` with the temporary password from `seed:admin`, and change it
when prompted.

---

## 11. Backups

Self-hosting means nobody else is taking them. This database holds a school's
fee receipts and payroll.

Two layers. Use both.

### 11.1 `mongodump` — the real one

```bash
sudo apt install -y mongodb-database-tools

sudo tee /srv/backup-sps.sh >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
STAMP=$(date +%F_%H-%M)
OUT=/srv/backups/sps/$STAMP
mkdir -p "$OUT"

mongodump \
  --uri="mongodb://sps_app:YOUR_PASSWORD@127.0.0.1:27017/sps?authSource=sps" \
  --gzip --archive="$OUT/sps.archive.gz"

# Keep 30 days; anything older goes, so the disk cannot fill.
find /srv/backups/sps -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
echo "$(date -Is) backup ok -> $OUT"
EOF

sudo chmod 700 /srv/backup-sps.sh
sudo chown deploy:deploy /srv/backup-sps.sh
```

Schedule it with a systemd timer:

```bash
sudo tee /etc/systemd/system/sps-backup.service >/dev/null <<'EOF'
[Unit]
Description=SPS database backup
[Service]
Type=oneshot
User=deploy
ExecStart=/srv/backup-sps.sh
EOF

sudo tee /etc/systemd/system/sps-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Run the SPS backup daily
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now sps-backup.timer
sudo systemctl start sps-backup.service   # test it once, now
ls -lh /srv/backups/sps/
```

> This is ops scheduling, not application scheduling. The app itself still has
> no cron — every recurring action in it (raising fees, generating slips) is an
> idempotent button, on purpose.

**Restore:**

```bash
mongorestore --uri="mongodb://sps_app:PASS@127.0.0.1:27017/sps?authSource=sps" \
  --gzip --archive=/srv/backups/sps/<stamp>/sps.archive.gz --drop
```

### 11.2 Off the box

A backup on the same disk as the database is not a backup. Once a week, from
your Mac:

```bash
rsync -avz deploy@<VPS_IP>:/srv/backups/sps/ ~/Backups/sps/
```

### 11.3 The app's own drift check

Not a backup, but the thing that tells you the books are sound:

```bash
cd /srv/apps/sps-backend && npm run recompute:balances
```

It must print **"No drift. Every balance matches the ledger."** Run it after
every deploy and once a month. If it ever reports drift, a write path has
bypassed `ledger.service` — investigate before using `--fix`.

---

## 12. Keeping storage down

200 GB is a lot, but these are the things that quietly eat it.

```bash
# Journald — uncapped by default
sudo mkdir -p /etc/systemd/journald.conf.d
echo -e "[Journal]\nSystemMaxUse=200M" | sudo tee /etc/systemd/journald.conf.d/size.conf
sudo systemctl restart systemd-journald

# APT caches
sudo apt autoremove -y && sudo apt clean

# Snap is preinstalled on Ubuntu and usually unused here
sudo systemctl disable --now snapd.service snapd.socket 2>/dev/null || true
```

Already handled above: Mongo log rotation (§4.6), PM2 log rotation (§8.3),
backup retention (§11.1), `--omit=dev` installs (§7.1), zstd compression
(§4.2).

Check disk any time:

```bash
df -h /
du -sh /srv/* /var/log /var/lib/mongodb | sort -h
```

---

## 13. Updating (the `git pull` flow)

Write this once:

```bash
nano /srv/apps/sps-backend/deploy.sh
```

```bash
#!/bin/bash
set -euo pipefail
cd /srv/apps/sps-backend

echo "==> pulling"
git pull --ff-only

echo "==> dependencies"
npm ci --omit=dev

echo "==> indexes"
npm run build:indexes

echo "==> reload"
pm2 reload sps-api

sleep 2
curl -fsS localhost:8001/health >/dev/null && echo "==> healthy" || {
    echo "!! health check FAILED — check: pm2 logs sps-api"; exit 1; }

echo "==> drift check"
npm run recompute:balances
```

```bash
chmod +x /srv/apps/sps-backend/deploy.sh
```

From then on, every backend update is:

```bash
ssh deploy@<VPS_IP> '/srv/apps/sps-backend/deploy.sh'
```

Frontend update:

```bash
ssh deploy@<VPS_IP> 'cd /srv/apps/sps-frontend && git pull --ff-only && npm ci && npx vite build'
```

`build:indexes` is safe to re-run — it only creates what is missing.

---

## 14. Adding project 2 and 3

Everything above was built so this is short. For Solar4U:

**1. Its own Mongo user and database**

```bash
mongosh "mongodb://root_admin:PASS@127.0.0.1:27017/admin"
```
```js
use solar4u
db.createUser({ user:"solar4u_app", pwd:"...", roles:[{role:"readWrite", db:"solar4u"}] })
```

**2. Clone and configure** — `/srv/apps/solar4u-backend`, `PORT=8002`, its own
`.env` at `chmod 600`.

**3. PM2** — its own `ecosystem.config.js` with `name: 'solar4u-api'`, then
`pm2 start ... && pm2 save`.

> Solar4U runs cron jobs. If you ever set `instances` above 1 there, guard
> every job with `process.env.NODE_APP_INSTANCE === '0'` or each job fires
> once per process.

**4. Nginx** — `/etc/nginx/sites-available/solar4u.conf`, same shape, just a
different `server_name`, `root` and `proxy_pass` port. Reuse the snippet:

```nginx
server {
    listen 80;
    server_name solar.yourdomain.com;
    location /api/ {
        proxy_pass http://127.0.0.1:8002;
        include snippets/node-proxy.conf;
    }
    location / { try_files $uri $uri/ /index.html; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/solar4u.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d solar.yourdomain.com
```

**5. Backup** — copy `/srv/backup-sps.sh` to `/srv/backup-solar4u.sh`, change
the URI and paths, add a second timer.

Nothing about SPS is touched at any point. Update the port register in §6.

---

## 15. If something breaks

| Symptom | Where to look |
|---|---|
| Site shows 502 | `pm2 list` — is `sps-api` online? `pm2 logs sps-api` |
| `/health` times out | Mongo down: `sudo systemctl status mongod` |
| *"Transaction numbers are only allowed on a replica set"* | §4.3 — `mongosh --eval 'rs.status().members[0].stateStr'` must say PRIMARY |
| Login works, then logs out after 15 min | Cookie not coming back. `FRONTEND_URL` must match the site's origin exactly, and `COOKIE_SAMESITE=lax` only works same-origin |
| 403 on every write from one user | That role's permissions — Settings, or `npm run seed:admin` to reseed defaults |
| App will not start | It validates env at boot; read the message, it names the key |
| Balances look wrong | `npm run recompute:balances` — report first, `--fix` only after you understand the cause |

Handy:

```bash
pm2 logs sps-api --lines 200
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/mongodb/mongod.log
sudo journalctl -u mongod -n 100 --no-pager
```

---

## 16. Go-live checklist

- [ ] `rs.status()` reports **PRIMARY**
- [ ] Mongo refuses unauthenticated connections
- [ ] `ufw status` shows only 22, 80, 443 — **27017 is not listed**
- [ ] `curl https://school.yourdomain.com/health` returns 200 over HTTPS
- [ ] Admin password changed from the seeded temporary one
- [ ] `sudo certbot renew --dry-run` passes
- [ ] `pm2 save` done and `sudo reboot` tested — everything comes back by itself
- [ ] Backup timer ran once and `/srv/backups/sps/` has an archive
- [ ] A restore has been tested into a scratch database
- [ ] `npm run recompute:balances` prints **No drift**
- [ ] One real fee collected end to end, receipt printed, and the ledger,
      the student's balance and the monthly rollup all moved
