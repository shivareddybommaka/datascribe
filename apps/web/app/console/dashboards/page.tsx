import { redirect } from 'next/navigation';

/** Only the sales dashboard so far (M9 part 2); ops, finance and client follow. */
export default function Dashboards() {
  redirect('/console/dashboards/sales');
}
