import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  // 32 random bytes as 64 hex characters. Encrypts saved PDF passwords and the stored statement files.
  // Generate: openssl rand -hex 32   (losing this key makes saved passwords and files unreadable)
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)'),
  QPDF_PATH: z.string().default('qpdf'),

  // where uploaded statements and photos live: a folder on this machine, an S3 bucket, or the database
  STORAGE_DRIVER: z.enum(['local', 's3', 'db']).default('local'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_PREFIX: z.string().default(''), // e.g. "kharcha/"; must end with "/" when set
  S3_ENDPOINT: z.string().optional(), // only for S3-compatible stores such as MinIO
  MAX_UPLOAD_MB: z.coerce.number().positive().default(15),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const parsed = schema
  .refine((v) => v.STORAGE_DRIVER !== 's3' || Boolean(v.S3_BUCKET), {
    message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
    path: ['S3_BUCKET'],
  })
  .safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
