import { AdminGuard } from '@/components/auth/admin-guard';

export default function BrokersLayout({ children }: { children: React.ReactNode }) {
  return <AdminGuard>{children}</AdminGuard>;
}
