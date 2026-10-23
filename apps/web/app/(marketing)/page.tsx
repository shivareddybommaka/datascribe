import { MarketingPage, pageMetadata } from '@/components/marketing/marketing-page';

export const revalidate = 60;
export const generateMetadata = () => pageMetadata('home');

export default function HomePage() {
  return <MarketingPage slug="home" />;
}
