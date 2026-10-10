import { Router } from 'express';
import multer from 'multer';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { uploadLimiter } from '../../middleware/rateLimit';
import * as svc from './statements.service';

export const statementsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // some phones send application/octet-stream for PDFs; the real check is the %PDF- header
    const ok = ['application/pdf', 'application/octet-stream'].includes(file.mimetype);
    if (!ok) return cb(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF files are allowed'));
    cb(null, true);
  },
});

const idParam = z.object({ id: z.string().uuid() });
// Text fields sent next to the file, only used when the bank locked the PDF:
//   passwordId     a saved password (from GET /pdf-passwords)
//   password       a password typed just now
//   savePassword   "true" to remember the typed one, passwordLabel names it
// With none of them, every saved password is tried automatically.
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
// merge: JSON [{manualId, key}] of hand-added entries the user accepted as the same payment as a statement row
const mergeList = z
  .array(z.object({ manualId: z.string().uuid(), key: z.string().max(300) }))
  .max(500);
const applyList = z.array(z.string().uuid()).max(500);
const unlockFields = z.object({
  merge: z.string().max(100_000).optional(),
  apply: z.string().max(100_000).optional(), // JSON [transaction id] the user accepted the bank's version of
  passwordId: z.string().uuid().optional(),
  password: z.string().min(1).max(100).optional(),
  savePassword: bool.optional(),
  passwordLabel: z.string().trim().max(60).optional(),
});

const needFile = (file: Express.Multer.File | undefined) => {
  if (!file) throw new AppError(400, 'FILE_REQUIRED', 'Attach a PDF in the "file" field');
  return file;
};

// POST /statements/preview   same form as the upload, saves nothing
statementsRouter.post('/preview', uploadLimiter, upload.single('file'), async (req, res) => {
  const f = unlockFields.parse(req.body ?? {});
  res.json(await svc.previewStatement(req.userId, needFile(req.file), { passwordId: f.passwordId, password: f.password }));
});

// POST /statements   multipart/form-data, field name "file"
statementsRouter.post('/', uploadLimiter, upload.single('file'), async (req, res) => {
  const f = unlockFields.parse(req.body ?? {});
  let merge: z.infer<typeof mergeList> = [];
  if (f.merge) {
    try {
      merge = mergeList.parse(JSON.parse(f.merge));
    } catch {
      throw new AppError(400, 'BAD_REQUEST', '"merge" must be a JSON list of { manualId, key }');
    }
  }
  let apply: string[] = [];
  if (f.apply) {
    try {
      apply = applyList.parse(JSON.parse(f.apply));
    } catch {
      throw new AppError(400, 'BAD_REQUEST', '"apply" must be a JSON list of transaction ids');
    }
  }
  res.status(201).json(await svc.uploadStatement(req.userId, needFile(req.file), { ...f, merge, apply }));
});

// "Keep my version" for rows where the file differs: remembered, so they are not offered again
statementsRouter.post('/dismiss-changes', async (req, res) => {
  const items = z
    .array(z.object({ id: z.string().uuid(), signature: z.string().min(1).max(64) }))
    .max(500)
    .parse(req.body?.items ?? []);
  await svc.dismissChanges(req.userId, items);
  res.status(204).end();
});

// fills in details older imports did not save (UPI id, bank, reference), from the stored PDF
statementsRouter.post('/:id/reread', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await svc.rereadStatement(req.userId, id));
});

statementsRouter.get('/', async (req, res) => {
  res.json({ items: await svc.listStatements(req.userId) });
});

statementsRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(svc.toStatementDto(await svc.getStatement(req.userId, id)));
});

// the stored PDF, unlocked (no password needed to open it)
statementsRouter.get('/:id/file', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const row = await svc.getStatement(req.userId, id);
  const { data, fileName } = await svc.openStatementFile(row);
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  if (Buffer.isBuffer(data)) res.send(data);
  else await pipeline(data, res);
});

statementsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await svc.deleteStatement(req.userId, id);
  res.status(204).end();
});
