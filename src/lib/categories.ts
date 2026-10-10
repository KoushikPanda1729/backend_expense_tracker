export const EXPENSE_CATEGORIES = [
  'Food',
  'Shopping',
  'Travel',
  'Recharge & Bills',
  'Health',
  'Insurance',
  'Investment',
  'Education',
  'Loans & EMI',
  'Transfer',
] as const;

export const INCOME_CATEGORIES = ['Salary', 'Received'] as const;

export const CATEGORIES = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES] as const;
export type Category = (typeof CATEGORIES)[number];

// ponytail: keyword rules, first match wins, matched on the description in lower case with spaces
// removed (the PDF wraps long UPI ids). SBI cuts names to 8 characters ("Indian R", "Policyba"), so
// the optional 3rd value is a readable name. Make the rules per-user if they misfile.
const RULES: Array<[keyword: string, category: Category, name?: string]> = [
  ['vtaar', 'Salary'],
  ['acme', 'Salary'],
  ['one97', 'Received', 'Paytm'],
  ['groww', 'Investment', 'Groww mutual fund'],
  ['indianclearin', 'Investment', 'Indian Clearing Corp (SIP)'],
  ['policyba', 'Insurance', 'Policybazaar'],
  ['airtel', 'Recharge & Bills', 'Airtel'],
  ['bharti', 'Recharge & Bills'],
  ['jio', 'Recharge & Bills'],
  ['axio', 'Loans & EMI', 'Axio'],
  ['physicsw', 'Education', 'Physics Wallah'],
  ['apollo', 'Health'],
  ['indianr', 'Travel', 'Indian Railways'],
  ['railsbi', 'Travel', 'Indian Railways'],
  ['irctc', 'Travel', 'IRCTC'],
  ['uts', 'Travel'],
  ['playstore', 'Shopping', 'Google Play'],
  ['zomato', 'Food', 'Zomato'],
  ['swiggy', 'Food', 'Swiggy'],
];

// UPI ids of shops: Paytm / PhonePe / BharatPe / GPay merchant QR codes. People pay with a phone number or name@bank.
const SHOP_QR = /paytmqr|paytm\.s\w|bharatpe|gpay-?\d|\/q\d{7,}\//;

const isValid = (c: Category, isIncome: boolean) =>
  (isIncome ? (INCOME_CATEGORIES as readonly string[]) : (EXPENSE_CATEGORIES as readonly string[])).includes(c);

/** Category (and a readable name when known) for a bank description. */
export function classify(raw: string, isIncome: boolean): { category: Category; name?: string } {
  const flat = raw.toLowerCase().replace(/\s+/g, '');
  const hit = RULES.find(([keyword, category]) => flat.includes(keyword) && isValid(category, isIncome));
  if (hit) return { category: hit[1], name: hit[2] };
  if (!isIncome && SHOP_QR.test(flat)) return { category: 'Shopping' };
  return { category: isIncome ? 'Received' : 'Transfer' };
}
