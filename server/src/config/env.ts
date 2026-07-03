/**
 * env.ts — Typed environment variable loader
 *
 * Validates that all required environment variables are present at startup.
 * Throws a descriptive error immediately if any are missing, preventing
 * confusing runtime failures later.
 */
import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[ENV] Missing required environment variable: "${key}"\n` +
      `      → Copy server/.env.example to server/.env and fill in the values.`
    );
  }
  // .trim() is CRITICAL on Windows: .env files saved with CRLF endings cause
  // process.env values to include a trailing \r, which silently corrupts Base64
  // authorization headers (e.g., the Midtrans "Access Denied" error).
  return value.trim();
}

export const env = {
  PORT: parseInt(process.env.PORT ?? '3001', 10),
  FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:5173',

  // Supabase
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET ?? 'food-images',

  // Google Gemini AI
  GEMINI_API_KEY: requireEnv('GEMINI_API_KEY'),
  GEMINI_MODEL: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',

  // Midtrans
  MIDTRANS_SERVER_KEY: requireEnv('MIDTRANS_SERVER_KEY'),
  MIDTRANS_CLIENT_KEY: requireEnv('MIDTRANS_CLIENT_KEY'),
  MIDTRANS_IS_PRODUCTION: process.env.MIDTRANS_IS_PRODUCTION === 'true',
} as const;
