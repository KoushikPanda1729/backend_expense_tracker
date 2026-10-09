import { Router } from 'express';
import multer from 'multer';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../lib/errors';
import { uploadLimiter } from '../../middleware/rateLimit';
import { storage } from '../../storage';
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

// POST /statements   multipart/form-data, field name "file"
statementsRouter.post('/', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Attach a PDF in the "file" field');
  res.status(201).json(await svc.uploadStatement(req.userId, req.file));
});

statementsRouter.get('/', async (req, res) => {
  res.json({ items: await svc.listStatements(req.userId) });
});

statementsRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(svc.toStatementDto(await svc.getStatement(req.userId, id)));
});

// the original PDF
statementsRouter.get('/:id/file', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const row = await svc.getStatement(req.userId, id);
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  await pipeline(await storage.stream(row.storage_key), res);
});

statementsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await svc.deleteStatement(req.userId, id);
  res.status(204).end();
});
