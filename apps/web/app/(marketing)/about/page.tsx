import { MarketingPage, pageMetadata } from '@/components/marketing/marketing-page';

export const revalidate = 60;
export const generateMetadata = () => pageMetadata('about');

export default function AboutPage() {
  return <MarketingPage slug="about" />;
}
