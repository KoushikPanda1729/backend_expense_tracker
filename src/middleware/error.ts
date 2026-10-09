import { ErrorRequestHandler, RequestHandler, Request } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { AppError, isUniqueViolation } from '../lib/errors';

const requestId = (req: Request) => (req as Request & { id?: string | number }).id;

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, requestId: requestId(req) },
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const id = requestId(req);
  const send = (status: number, code: string, message: string, details?: unknown) =>
    res.status(status).json({ error: { code, message, details, requestId: id } });

  if (err instanceof AppError) return send(err.status, err.code, err.message, err.details);

  if (err instanceof ZodError) {
    return send(
      400,
      'VALIDATION_ERROR',
      'Some fields are invalid',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }

  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return send(413, 'FILE_TOO_LARGE', 'The file is too large');
    return send(400, 'UPLOAD_ERROR', err.message);
  }

  // body-parser: malformed JSON, payload too large
  const status = (err as { status?: number }).status;
  if (status === 400 && (err as { type?: string }).type === 'entity.parse.failed') {
    return send(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (status === 413) return send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');

  if (isUniqueViolation(err)) return send(409, 'CONFLICT', 'This record already exists');

  logger.error({ err, requestId: id }, 'unhandled error');
  return send(500, 'INTERNAL_ERROR', 'Something went wrong');
};
