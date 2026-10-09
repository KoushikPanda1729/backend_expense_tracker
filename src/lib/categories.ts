export const EXPENSE_CATEGORIES = [
  'Food',
  'Shopping',
  'Travel',
  'Recharge & Bills',
  'Health',
  'Insurance',
  'Investment',
  'Transfer',
] as const;

export const INCOME_CATEGORIES = ['Salary', 'Received'] as const;

export const CATEGORIES = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES] as const;
export type Category = (typeof CATEGORIES)[number];

// ponytail: keyword rules, first match wins (same as the mobile app). Make them per-user if they misfile.
const RULES: Array<[string, Category]> = [
  ['vtaar', 'Salary'],
  ['acme', 'Salary'],
  ['groww', 'Investment'],
  ['policyba', 'Insurance'],
  ['airtel', 'Recharge & Bills'],
  ['bharti', 'Recharge & Bills'],
  ['jio', 'Recharge & Bills'],
  ['apollo', 'Health'],
  ['uts', 'Travel'],
  ['irctc', 'Travel'],
  ['zomato', 'Food'],
  ['swiggy', 'Food'],
];

export function categorize(raw: string, isIncome: boolean): Category {
  const low = raw.toLowerCase();
  const hit = RULES.find(([keyword]) => low.includes(keyword));
  if (hit) return hit[1];
  return isIncome ? 'Received' : 'Transfer';
}
