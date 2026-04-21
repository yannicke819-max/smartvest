import { type NextRequest, NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as 'magiclink' | 'recovery' | 'email' | null;
  const next = searchParams.get('next') ?? '/';

  const supabase = createSupabaseServerClient();

  // PKCE flow (OAuth / newer OTP)
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Auto-create minimal user_profiles row for new OAuth users (upsert = no-op if exists).
      if (data?.user) {
        await supabase.from('user_profiles').upsert(
          { id: data.user.id, updated_at: new Date().toISOString() },
          { onConflict: 'id', ignoreDuplicates: true },
        );
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // OTP token_hash flow (magic link email)
  if (tokenHash && type) {
    const { data: otpData, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      if (otpData?.user) {
        await supabase.from('user_profiles').upsert(
          { id: otpData.user.id, updated_at: new Date().toISOString() },
          { onConflict: 'id', ignoreDuplicates: true },
        );
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/sign-in?error=callback_failed`);
}
