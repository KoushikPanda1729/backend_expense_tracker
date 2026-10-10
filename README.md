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
