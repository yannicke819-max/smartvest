import { z } from 'zod';

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  NEXT_PUBLIC_FEATURE_PERSONAL_MODE: z.string().default('true'),
  NEXT_PUBLIC_FEATURE_SAFE_PUBLIC_MODE: z.string().default('false'),
  NEXT_PUBLIC_FEATURE_REGULATED_MODE: z.string().default('false'),
});

export const publicEnv = publicSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_FEATURE_PERSONAL_MODE: process.env.NEXT_PUBLIC_FEATURE_PERSONAL_MODE,
  NEXT_PUBLIC_FEATURE_SAFE_PUBLIC_MODE: process.env.NEXT_PUBLIC_FEATURE_SAFE_PUBLIC_MODE,
  NEXT_PUBLIC_FEATURE_REGULATED_MODE: process.env.NEXT_PUBLIC_FEATURE_REGULATED_MODE,
});
