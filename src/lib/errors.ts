/** An error the client is allowed to see. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, 'BAD_REQUEST', m, d);
export const unauthorized = (m = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', m);
export const notFound = (m = 'Not found') => new AppError(404, 'NOT_FOUND', m);
export const conflict = (m: string, d?: unknown) => new AppError(409, 'CONFLICT', m, d);
export const unprocessable = (m: string, d?: unknown) => new AppError(422, 'UNPROCESSABLE', m, d);

/** Postgres unique-constraint violation. */
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';
