import { z } from 'zod';
import { CATEGORIES, EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../lib/categories';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const category = z.enum(CATEGORIES);

export const listQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  type: z.enum(['income', 'expense']).optional(),
  // comma separated: ?category=Food,Travel
  category: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(category).optional()),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['newest', 'oldest', 'highest', 'lowest']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

const fields = z.object({
  date,
  merchant: z.string().trim().min(1).max(120),
  category,
  amount: z.number().positive().max(1_000_000_000),
  isIncome: z.boolean(),
});
const mode = z.string().trim().min(1).max(20);

// income entries must use an income category and the other way round
const categoryMatchesType = (v: { category: string; isIncome: boolean }) =>
  (v.isIncome ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).some((c) => c === v.category);

export const createSchema = fields
  .extend({ mode: mode.default('Manual') })
  .refine(categoryMatchesType, { message: 'Category does not match the transaction type', path: ['category'] });

// no defaults here, so a PATCH only changes what the client sends
export const updateSchema = fields
  .extend({ mode })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change' });

// move every transaction of one merchant (same direction) to a category
export const recategorizeSchema = z
  .object({ merchant: fields.shape.merchant, category, isIncome: z.boolean() })
  .refine(categoryMatchesType, { message: 'Category does not match the transaction type', path: ['category'] });

export type ListQuery = z.infer<typeof listQuery>;
export type CreateInput = z.infer<typeof createSchema>;
