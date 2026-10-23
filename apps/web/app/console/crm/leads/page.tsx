import { Suspense } from 'react';
import { LeadsView } from './leads-view';

export default function LeadsPage() {
  return (
    <Suspense>
      <LeadsView />
    </Suspense>
  );
}
