import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const PUBLIC_PATHS = ['/sign-in', '/auth/callback'];
const ONBOARDING_PATH = '/onboarding';
const ONBOARDING_COOKIE = 'sv_onboarded_v1';
const ONBOARDING_SKIP_PATHS = [
  '/sign-in',
  '/auth/callback',
  '/onboarding',
  '/legal',
  '/help',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Chemins publics: toujours accessibles.
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // En PERSONAL_MODE sans Supabase configuré : on laisse passer (dev local).
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.set({ name, value: '', ...options });
        response = NextResponse.next({ request });
        response.cookies.set({ name, value: '', ...options });
      },
    },
  });

  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('next', pathname);
    return NextResponse.redirect(signIn);
  }

  // Onboarding guard : redirige les nouveaux utilisateurs vers /onboarding.
  // Exempté pour les chemins légaux, aide, et /onboarding lui-même.
  const skipOnboarding = ONBOARDING_SKIP_PATHS.some((p) => pathname.startsWith(p));
  if (!skipOnboarding) {
    const onboardingCookie = request.cookies.get(ONBOARDING_COOKIE);
    if (!onboardingCookie) {
      return NextResponse.redirect(new URL(ONBOARDING_PATH, request.url));
    }
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|css|js)$).*)'],
};
