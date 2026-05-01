import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const authorization = req.headers.get('authorization');
  if (!authorization) {
    return NextResponse.json({ message: 'Authentification requise' }, { status: 401 });
  }

  const forwardedFor = req.headers.get('x-forwarded-for')
    ?? req.headers.get('x-real-ip')
    ?? undefined;

  const headers: Record<string, string> = { authorization };
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

  const upstream = await fetch(`${API_URL}/me`, {
    method: 'DELETE',
    headers,
  });

  if (upstream.status === 204) {
    return new NextResponse(null, { status: 204 });
  }

  const body = await upstream.text().catch(() => 'Erreur serveur');
  return NextResponse.json({ message: body }, { status: upstream.status });
}
