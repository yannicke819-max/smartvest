import { AdminGuard } from '@/components/auth/admin-guard';

export default function StrategyModeLayout({ children }: { children: React.ReactNode }) {
  return <AdminGuard>{children}</AdminGuard>;
}
