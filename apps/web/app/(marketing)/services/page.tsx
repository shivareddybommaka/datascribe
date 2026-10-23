import { MarketingPage, pageMetadata } from '@/components/marketing/marketing-page';

export const revalidate = 60;
export const generateMetadata = () => pageMetadata('services');

export default function ServicesPage() {
  return <MarketingPage slug="services" />;
}
