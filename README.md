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
| GET / PATCH | `/users/me` | profile, `{ name }` |
| POST | `/users/me/password` | `{ currentPassword, newPassword }`, signs out all devices |
| POST | `/statements` | multipart, field `file` (PDF). Stores it, parses it (SBI), imports the transactions |
| GET | `/statements`, `/statements/:id` | list / one |
| GET | `/statements/:id/file` | download the original PDF |
| DELETE | `/statements/:id` | removes the file and the transactions imported from it |
| GET | `/transactions` | `?from&to&type=income\|expense&category=Food,Travel&q&limit&cursor` |
| POST / PATCH / DELETE | `/transactions`, `/transactions/:id` | manual entries |
| GET | `/budgets` | |
| PUT / DELETE | `/budgets/:category` | `{ limit }` |
| GET | `/analytics/summary` | `?from&to` totals, categories, top merchants, monthly |

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

## Known limits / next steps

- PDF import supports SBI statement layout only, and not password-protected PDFs.
- No password reset yet (planned; changing the password while signed in works).
- Local file storage until S3 is added.
- Add a worker queue if statements get big enough that parsing should not block the request.
