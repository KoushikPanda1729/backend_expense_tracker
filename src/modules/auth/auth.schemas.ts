import { z } from 'zod';

export const countryCode = z.string().regex(/^\+\d{1,4}$/, 'Use a country code like +91');
export const phone = z.string().regex(/^\d{6,15}$/, 'Phone number must be 6 to 15 digits');
// 72 keeps the limit friendly to other hashers if you ever switch
export const password = z.string().min(8, 'Use at least 8 characters').max(72);

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(60),
  countryCode,
  phone,
  password,
});

export const loginSchema = z.object({
  countryCode,
  phone,
  password: z.string().min(1).max(72),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
