import { MarketingPage, pageMetadata } from '@/components/marketing/marketing-page';

export const revalidate = 60;
export const generateMetadata = () => pageMetadata('ai-medical-summary');

export default function AiMedicalSummaryPage() {
  return <MarketingPage slug="ai-medical-summary" />;
}
