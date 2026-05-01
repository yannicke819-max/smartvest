import { AdminGuard } from '@/components/auth/admin-guard';

export default function DelegationLayout({ children }: { children: React.ReactNode }) {
  return <AdminGuard>{children}</AdminGuard>;
}
