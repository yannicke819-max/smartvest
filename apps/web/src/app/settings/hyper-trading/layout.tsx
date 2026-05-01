import { AdminGuard } from '@/components/auth/admin-guard';

export default function HyperTradingLayout({ children }: { children: React.ReactNode }) {
  return <AdminGuard>{children}</AdminGuard>;
}
