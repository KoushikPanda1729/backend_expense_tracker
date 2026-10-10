# Kharcha backend

Express 5 + TypeScript + PostgreSQL API for the Kharcha expense tracker app.

## Run it locally

You already have Postgres running in Docker. This backend uses **its own database
(`kharcha_db`)** on that same server, so it never touches your other project's data.

```bash
cd backend
cp .env.example .env          # then edit DATABASE_URL (see below)
npm install
npm run db:create             # creates kharcha_db next to your existing databases (safe to repeat)
npm run migrate               # creates the tables
npm run dev                   # http://localhost:4000
```

`DATABASE_URL` needs the Postgres user and password of your container. To look them up:

```bash
docker inspect <container-name> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep POSTGRES
```

Then: `postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@localhost:5432/kharcha_db`.
Generate `JWT_ACCESS_SECRET` with
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

Other scripts: `npm test`, `npm run typecheck`, `npm run build && npm start`,
`npm run migrate:down`, `npm run migrate:create -- <name>`.

## Uploaded PDFs

Statements are stored on disk in `STORAGE_DIR` (default `./storage`, git-ignored) under
`statements/<userId>/<uuid>.pdf`. The database keeps only the key. To move to S3 later,
implement `StorageDriver` in `src/storage/s3.ts` and return it from `src/storage/index.ts`;
nothing else changes.

## API (all under `/api/v1`, JSON, errors look like `{ "error": { code, message, details, requestId } }`)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | `{ name, countryCode: "+91", phone: "9876543210", password }` returns user + tokens |
| POST | `/auth/login` | `{ countryCode, phone, password }` |
| POST | `/auth/refresh` | `{ refreshToken }` rotates the refresh token |
| POST | `/auth/logout` | `{ refreshToken }` |
| GET / PATCH | `/users/me` | profile; PATCH `{ name?, username? }` |
| PUT / GET / DELETE | `/users/me/photo` | profile photo. PUT is multipart, field `photo` (JPEG/PNG/WebP, max 5 MB), stored in `STORAGE_DIR/avatars` |
| DELETE | `/users/me/data` | "Delete my data": `?scope=transactions,budgets,passwords,photo` (default: first three). `transactions` also removes imported statements and their stored PDFs |
| DELETE | `/users/me` | deletes the account and every file; body `{ password }` |
| POST | `/users/me/password` | `{ currentPassword, newPassword }`, signs out all devices |
| GET / POST | `/pdf-passwords` | saved PDF passwords. GET returns `{ id, label, lastUsedAt }` only (the dropdown); POST `{ label, password }` |
| PATCH / DELETE | `/pdf-passwords/:id` | rename / change the password / remove |
| POST | `/statements/preview` | same form as the upload, **saves nothing**: how many rows are new vs already imported, totals, period, first 5 rows |
| POST | `/statements` | multipart: `file` (PDF) plus, for a locked PDF, `passwordId` (saved) or `password` (typed, add `savePassword=true` and `passwordLabel` to remember it). With none of them every saved password is tried. Stores the **unlocked** PDF, imports the transactions |
| GET | `/statements`, `/statements/:id` | list / one |
| GET | `/statements/:id/file` | download the PDF **unlocked** (no password needed to open it) |
| DELETE | `/statements/:id` | removes the file and the transactions imported from it |
| GET | `/transactions` | `?from&to&type=income\|expense&category=Food,Travel&q&sort=newest\|oldest\|highest\|lowest&limit&cursor` |
| POST / PATCH / DELETE | `/transactions`, `/transactions/:id` | manual entries |
| PATCH | `/transactions/recategorize` | `{ merchant, category, isIncome }` moves every transaction of that merchant to a category, returns `{ updated }` |
| GET | `/budgets` | |
| PUT / DELETE | `/budgets/:category` | `{ limit }` |
| GET | `/analytics/summary` | `?from&to` totals, categories, top merchants, monthly, by weekday, biggest expenses, small payments |
| GET | `/analytics/series` | `?granularity=day\|week\|month&from&to` income/expense per bucket for the line chart |
| GET | `/analytics/balance` | `?asOf=YYYY-MM-DD` account balance on that day (latest if omitted) |
| GET | `/analytics/balance-trend` | `?from&to` running balance per day |

Also: `GET /health` (liveness) and `GET /ready` (checks the database).
Send `Authorization: Bearer <accessToken>` on everything except `/auth/*`.

Try it:

```bash
curl -s localhost:4000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"name":"Koushik","countryCode":"+91","phone":"9876543210","password":"supersecret1"}'

curl -s localhost:4000/api/v1/statements -H "authorization: Bearer $TOKEN" \
  -F file=@"DepositAccountStatement.pdf"
```

## What is in place

- Input validated with zod everywhere; one error format; request ids on every log line and response.
- Passwords hashed with argon2id; short-lived access JWT (15 min) plus rotating refresh tokens
  stored only as hashes. A refresh token used twice signs the user out everywhere.
- helmet, CORS allow-list, gzip, body size limit, rate limits (global, stricter on auth and uploads).
- Uploads: size limit, `%PDF-` header check, SHA-256 so the same file cannot be imported twice,
  transactions deduplicated by bank reference number, files cleaned up if the import fails.
- Money is `numeric(14,2)` in Postgres, dates are plain `date` (no timezone surprises).
- Keyset pagination for transactions, indexes for the common queries.
- Graceful shutdown, fail-fast on a missing database, `/ready` for orchestrators, a Dockerfile.

## Locked PDFs, saved passwords and stored files

Banks usually lock statement PDFs. The flow:

1. The app shows a dropdown from `GET /pdf-passwords` (labels only) with "Add new password" and "No password".
2. The upload sends `passwordId`, or a typed `password` (optionally `savePassword=true`). If the app sends neither,
   the server tries every saved password, most recently used first, and remembers which one worked.
3. The server unlocks the file with **qpdf**, reads the rows, and stores **only the unlocked copy**.
   The locked original is not kept.
4. Wrong or missing password: `422 PDF_PASSWORD_INCORRECT` / `PDF_PASSWORD_REQUIRED`. The app can ask and send again.

Security notes:

- Saved passwords are **encrypted** (AES-256-GCM) with `ENCRYPTION_KEY`, not hashed, because they must be reused.
  They are never returned by the API or logged. Stored statements are encrypted with the same key.
- The key lives only in `.env`. Back it up: losing it makes saved passwords and stored files unreadable.
- qpdf gets the password through a private temp file (not the command line), deleted right after use.
- Install qpdf once: `brew install qpdf` (macOS) or `apt install qpdf`. The Dockerfile already does it.

## Known limits / next steps

- PDF import supports the SBI statement layout only (one parser per bank).
- No password reset yet (planned; changing the password while signed in works).
- Local file storage until S3 is added.
- Add a worker queue if statements get big enough that parsing should not block the request.

## Deploying (one server)

1. `cp .env.production.example .env.production` and fill in `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`.
2. `docker compose --env-file .env.production up -d --build`. This starts Postgres, runs the migrations once, then starts the API on port 4000.
   The image already contains **qpdf** (needed to open locked statements).
3. Put an **HTTPS** reverse proxy in front of port 4000 (Caddy: `your.domain { reverse_proxy localhost:4000 }`).
4. In the app, set `API_BASE_URL=https://your.domain/api/v1` in `frontend/.env` and rebuild.

Before going live:

- **Back up `ENCRYPTION_KEY`** somewhere safe. Without it saved PDF passwords and stored statements cannot be read.
- **Back up the database** (`pgdata` volume, or a nightly `pg_dump` to S3). With S3 the PDFs are already off the server.
- Files go where `STORAGE_DRIVER` says: **`db`** (the `files` table in your Postgres: nothing else to set up, backed up with the data), **`s3`** (next section) or `local` (the `storage` volume on the server).
- Keep `TRUST_PROXY=1` behind a proxy, and leave `CORS_ORIGINS` empty unless a browser app needs it.
- Check `GET /ready` (database) from your monitor.

## Files in S3

Set in `.env.production`: `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, optional `S3_PREFIX=kharcha/`.

1. Create a **private** bucket (Block all public access: on). Turn on **versioning** if you want undo for deletes.
2. On EC2, create an **IAM role** for the instance with this policy (replace `BUCKET`) and attach it. No access keys are needed:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::BUCKET/kharcha/*"
  }]
}
```

   Off AWS, set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for a user with the same policy.
3. Statements are encrypted with `ENCRYPTION_KEY` before upload, and S3 encrypts at rest too, so neither S3 nor anyone with bucket access can read a statement without that key.
4. For a local S3-compatible store (MinIO) also set `S3_ENDPOINT=http://localhost:9000`.

Existing files on disk are not moved automatically. Switching the driver on an account that already has statements leaves those
old files unreadable; copy `storage/` into the bucket under the same keys (with the prefix) first, or re-import.

## Deploy straight from your machine (no git, no CI)

`deploy/deploy.sh` copies this folder to the server over SSH and builds and runs the Docker image **on the server**.
There is no registry, and no ARM/x86 mismatch, because the image is built where it runs.

One-time, on AWS: launch an **Ubuntu 24.04 `t3.small`**, attach an Elastic IP and the S3 IAM role (see "Files in S3"), and open
ports 22 (your IP only) and 4000 (or 80/443 behind a proxy) in its security group.

```bash
cp .env.production.example .env.production     # fill in the secrets and S3_BUCKET
./deploy/deploy.sh ubuntu@<server-ip> -i ~/.ssh/<key>.pem --setup   # first time: also installs Docker + swap
./deploy/deploy.sh ubuntu@<server-ip> -i ~/.ssh/<key>.pem           # every later deploy
```

It stops with an error if the secrets are empty, and finishes by calling `GET /ready` on the server. A deploy rebuilds
only what changed, so a small update takes under a minute. Roll back by deploying the previous version of the folder.

The phone app needs **HTTPS** (iOS blocks plain HTTP to a public address). Easiest: a domain pointed at the Elastic IP and
Caddy in front (`your.domain { reverse_proxy localhost:4000 }`). Or skip public access and use Tailscale on the server and the phone.

## Files in the database (`STORAGE_DRIVER=db`)

Statements (about 50 KB each, already encrypted with `ENCRYPTION_KEY`) and profile photos are stored as `bytea` rows in the `files` table.
500 MB of database holds roughly 10,000 statements. Deleting a statement, or the account, deletes its file rows. Back up the
database and you have backed up the files. Switching from `local`/`s3` to `db` does not move existing files: re-import them.
