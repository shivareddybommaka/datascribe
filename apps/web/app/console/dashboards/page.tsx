'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useCan } from '@/components/auth';

/** Opens the first dashboard the user may see (ops, then sales); finance and client follow. */
export default function Dashboards() {
  const router = useRouter();
  const ops = useCan('dashboard_ops:view');
  useEffect(() => {
    router.replace(ops ? '/console/dashboards/ops' : '/console/dashboards/sales');
  }, [ops, router]);
  return null;
}
