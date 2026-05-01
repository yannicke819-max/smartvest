import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authorization = req.headers.get('authorization');
  if (!authorization) {
    return NextResponse.json({ message: 'Authentification requise' }, { status: 401 });
  }

  const upstream = await fetch(`${API_URL}/me/export`, {
    headers: { authorization },
  });

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => 'Erreur serveur');
    return NextResponse.json({ message: body }, { status: upstream.status });
  }

  const blob = await upstream.blob();
  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="smartvest-export.json"',
    },
  });
}
