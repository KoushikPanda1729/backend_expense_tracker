import { query } from '../../db/pool';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../lib/categories';

export interface PayeeRule {
  merchant: string;
  category: string;
  label: string | null;
}

// ponytail: a payee is its printed name (lower case). The bank cuts names to 8 characters, so two people
// can share one; key by UPI id as well if that ever happens.
export const keyOf = (merchant: string) => merchant.trim().toLowerCase();

const isIncomeCategory = (c: string) => (INCOME_CATEGORIES as readonly string[]).includes(c);
const isExpenseCategory = (c: string) => (EXPENSE_CATEGORIES as readonly string[]).includes(c);

export async function listRules(userId: string): Promise<PayeeRule[]> {
  return query<PayeeRule>(
    'SELECT merchant, category, label FROM payee_rules WHERE user_id = $1 ORDER BY merchant_key',
    [userId],
  );
}

/** The user's rules as a lookup, used while importing. */
export async function loadRules(userId: string) {
  const map = new Map((await listRules(userId)).map((r) => [keyOf(r.merchant), r]));
  return {
    map,
    /** The user's category for this payee, when it fits the direction of the payment. */
    apply(merchant: string, fallback: string, isIncome: boolean): string {
      const r = map.get(keyOf(merchant));
      if (!r) return fallback;
      return (isIncome ? isIncomeCategory(r.category) : isExpenseCategory(r.category)) ? r.category : fallback;
    },
  };
}

/** Remembers "this payee is X" and moves the payee's existing payments (same direction) to that category. */
export async function setRule(userId: string, merchant: string, category: string, label: string | null) {
  await query(
    `INSERT INTO payee_rules (user_id, merchant_key, merchant, category, label) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, merchant_key)
     DO UPDATE SET merchant = EXCLUDED.merchant, category = EXCLUDED.category, label = EXCLUDED.label, updated_at = now()`,
    [userId, keyOf(merchant), merchant, category, label],
  );
  const rows = await query(
    `UPDATE transactions SET category = $3, updated_at = now()
      WHERE user_id = $1 AND lower(trim(merchant)) = $2 AND is_income = $4 AND category <> $3 RETURNING id`,
    [userId, keyOf(merchant), category, isIncomeCategory(category)],
  );
  return { updated: rows.length };
}

export async function deleteRule(userId: string, merchant: string) {
  await query('DELETE FROM payee_rules WHERE user_id = $1 AND merchant_key = $2', [userId, keyOf(merchant)]);
}
