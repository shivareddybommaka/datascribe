'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useCan } from '@/components/auth';

/** Opens the first dashboard the user may see: ops, then sales, then finance. */
export default function Dashboards() {
  const router = useRouter();
  const ops = useCan('dashboard_ops:view');
  const sales = useCan('dashboard_sales:view');
  useEffect(() => {
    const to = ops ? 'ops' : sales ? 'sales' : 'finance';
    router.replace(`/console/dashboards/${to}`);
  }, [ops, sales, router]);
  return null;
}
