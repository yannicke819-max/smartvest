import { AdminGuard } from '@/components/auth/admin-guard';

export default function SniperLayout({ children }: { children: React.ReactNode }) {
  return <AdminGuard>{children}</AdminGuard>;
}
