import { richText } from './lexical';
import type { Page, PageSlug, Post, Site } from './types';

/**
 * Synthetic placeholder copy about Datascribe's LPO services. It seeds the CMS (apps/cms seed) and is
 * the fallback apps/web renders when the CMS can't be reached (e.g. `next build` without the CMS
 * running). Editors replace it in the CMS; never put prices here (they come from SubscriptionPlan).
 */

const demo = { label: 'Book a demo', href: '/contact?kind=demo', variant: 'primary' as const };
const pricing = { label: 'See pricing', href: '/pricing', variant: 'secondary' as const };

export const DEFAULT_SITE: Site = {
  siteName: 'Datascribe',
  nav: [
    { label: 'Services', href: '/services' },
    { label: 'AI Medical Summary', href: '/ai-medical-summary' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Resources', href: '/resources' },
    { label: 'About Us', href: '/about' },
    { label: 'Contact', href: '/contact' },
  ],
  headerCta: demo,
  footer: {
    tagline:
      'Medical record review, indexing and summaries for personal injury, med-mal and workers comp firms.',
    legal: 'Datascribe Technologies. Placeholder copy for development.',
  },
  cookieBanner: {
    message:
      'We use essential cookies to run this site. With your permission we also use analytics cookies (Google Analytics) to understand how the site is used. Nothing is loaded until you accept.',
    acceptLabel: 'Accept analytics',
    declineLabel: 'Decline',
  },
};

export const DEFAULT_PAGES: Record<PageSlug, Page> = {
  home: {
    slug: 'home',
    title: 'Home',
    hero: {
      eyebrow: 'Legal process outsourcing for law firms',
      heading: 'Medical record review your attorneys can rely on',
      subheading:
        'Datascribe turns thousands of pages of medical records into indexed, cited chronologies and summaries, so your team spends its time on the case, not the paperwork.',
      ctas: [demo, pricing],
    },
    sections: [
      {
        blockType: 'features',
        heading: 'What we deliver',
        intro: 'Every deliverable links each finding back to the source page.',
        items: [
          {
            title: 'Medical index',
            body: 'A page-by-page index of every record, grouped by provider and date, with duplicates flagged.',
          },
          {
            title: 'Medical chronology',
            body: 'Date-ordered visits, diagnoses, procedures and medications, each with a page citation.',
          },
          {
            title: 'Narrative summary',
            body: 'A plain-English summary of treatment, causation-relevant findings and gaps in care.',
          },
        ],
      },
      {
        blockType: 'steps',
        heading: 'How it works',
        items: [
          {
            title: 'Upload',
            body: 'Send records securely through the client portal: large PDFs, resumable uploads.',
          },
          {
            title: 'We review',
            body: 'OCR and AI-assisted drafting, then trained summarizers and a QA reviewer check every entry.',
          },
          {
            title: 'Download',
            body: 'Get PDF and DOCX deliverables in the portal, ready for demand letters and depositions.',
          },
        ],
      },
      {
        blockType: 'cta',
        heading: 'See a sample chronology',
        body: 'Book a 20-minute walkthrough with a synthetic case file.',
        cta: demo,
      },
    ],
    seo: {
      title: 'Datascribe: medical record review for law firms',
      description:
        'Medical indexes, chronologies and summaries for personal injury, med-mal and workers comp firms.',
    },
  },
  about: {
    slug: 'about',
    title: 'About Us',
    hero: {
      eyebrow: 'About Datascribe',
      heading: 'A medical review team that works like part of your firm',
      subheading:
        'We combine clinical reviewers, legal process specialists and careful use of AI to deliver record reviews firms can cite with confidence.',
      ctas: [{ label: 'Talk to us', href: '/contact', variant: 'primary' }],
    },
    sections: [
      {
        blockType: 'content',
        heading: 'Our approach',
        body: richText(
          'Medical records are long, inconsistent and easy to misread. We built Datascribe around one rule: every statement in a deliverable must point to the page it came from.',
          'Our reviewers work assigned cases only, every deliverable passes a second-person QA review, and access to records is logged.',
        ),
      },
      {
        blockType: 'features',
        heading: 'What we care about',
        items: [
          {
            title: 'Accuracy',
            body: 'Page citations on every entry and a QA sign-off before anything is delivered.',
          },
          {
            title: 'Privacy',
            body: 'Designed around HIPAA and India’s DPDP Act: encryption, least-privilege access and audit logs.',
          },
          {
            title: 'Turnaround',
            body: 'Clear turnaround times per plan, with status visible in the portal at every step.',
          },
        ],
      },
    ],
    seo: {
      title: 'About Datascribe',
      description:
        'Clinical reviewers and legal process specialists delivering cited medical record reviews.',
    },
  },
  services: {
    slug: 'services',
    title: 'Services',
    hero: {
      eyebrow: 'Services',
      heading: 'Record review for every stage of a case',
      subheading:
        'From intake screening to trial preparation, choose the deliverable that fits the matter.',
      ctas: [demo],
    },
    sections: [
      {
        blockType: 'features',
        heading: 'Deliverables',
        items: [
          {
            title: 'Medical indexing and bookmarking',
            body: 'Searchable, bookmarked PDFs organised by provider, date and record type.',
          },
          {
            title: 'Medical chronologies',
            body: 'Detailed, cited timelines of care for demand packages, mediation and depositions.',
          },
          {
            title: 'Narrative summaries',
            body: 'Readable summaries of injuries, treatment and prognosis for attorneys and adjusters.',
          },
          {
            title: 'Missing records review',
            body: 'Gaps in dates of service and providers flagged so you can request what is missing.',
          },
        ],
      },
      {
        blockType: 'features',
        heading: 'Practice areas',
        items: [
          {
            title: 'Personal injury',
            body: 'Motor vehicle, premises and product liability claims.',
          },
          {
            title: 'Medical malpractice',
            body: 'Standard-of-care timelines and deviations, cited to the record.',
          },
          {
            title: 'Workers compensation',
            body: 'Injury, treatment and return-to-work history in one place.',
          },
        ],
      },
      {
        blockType: 'cta',
        heading: 'Not sure which deliverable you need?',
        body: 'Tell us about the matter and we will suggest one.',
        cta: { label: 'Contact us', href: '/contact', variant: 'primary' },
      },
    ],
    seo: {
      title: 'Services: medical indexing, chronologies and summaries',
      description:
        'Medical indexing, chronologies, narrative summaries and missing-records review for law firms.',
    },
  },
  'ai-medical-summary': {
    slug: 'ai-medical-summary',
    title: 'AI Medical Summary',
    hero: {
      eyebrow: 'AI Medical Summary',
      heading: 'AI drafts, people verify',
      subheading:
        'Our pipeline reads, codes and drafts; trained reviewers check every entry against the source page before you see it.',
      ctas: [demo, pricing],
    },
    sections: [
      {
        blockType: 'steps',
        heading: 'Inside the pipeline',
        items: [
          {
            title: 'Text extraction',
            body: 'OCR for scanned pages and the text layer for digital PDFs, page by page.',
          },
          {
            title: 'Clinical coding',
            body: 'Diagnoses, procedures and medications matched to standard vocabularies from public medical data sources.',
          },
          {
            title: 'Drafting',
            body: 'A draft chronology and summary, every entry carrying its page citation.',
          },
          {
            title: 'Human review and QA',
            body: 'A summarizer edits the draft and a QA reviewer approves it before delivery.',
          },
        ],
      },
      {
        blockType: 'faq',
        heading: 'Questions firms ask',
        items: [
          {
            question: 'Is patient data sent to an AI vendor?',
            answer:
              'Only to a vendor covered by a business associate agreement, and only when your firm has approved it. Until then drafting runs without an external model.',
          },
          {
            question: 'Can I trust an AI-written summary?',
            answer:
              'Every entry links to its source page and a person checks it. The AI saves reading time; it does not sign off.',
          },
          {
            question: 'What formats do I get?',
            answer: 'PDF and DOCX, downloadable from the client portal.',
          },
        ],
      },
    ],
    seo: {
      title: 'AI Medical Summary: AI drafts, people verify',
      description:
        'AI-assisted medical chronologies and summaries with page citations and human QA on every entry.',
    },
  },
  pricing: {
    slug: 'pricing',
    title: 'Pricing',
    hero: {
      eyebrow: 'Pricing',
      heading: 'Simple monthly plans',
      subheading: 'Pick a page allowance. Pages over the allowance are billed per page.',
      ctas: [],
    },
    pricing: {
      heading: 'Plans',
      intro: 'All plans include the client portal, page-cited deliverables and QA review.',
      highlightedPlan: 'Professional',
      includedPagesLabel: 'pages included each month',
      overageLabel: 'per extra page',
      cardCta: { label: 'Get started', href: '/contact?kind=demo', variant: 'primary' },
      footnote: 'Prices exclude applicable taxes. Unused pages do not roll over.',
      unavailableMessage:
        'Plan details are being updated. Contact us for current pricing and we will reply within one business day.',
      taglines: [
        { planName: 'Starter', tagline: 'For solo practitioners and small caseloads.' },
        { planName: 'Professional', tagline: 'For growing firms with a steady flow of matters.' },
        { planName: 'Enterprise', tagline: 'For high-volume firms that need a dedicated team.' },
      ],
    },
    sections: [
      {
        blockType: 'faq',
        heading: 'Pricing questions',
        items: [
          {
            question: 'How are pages counted?',
            answer:
              'Every page of every uploaded record counts once, including duplicates we flag.',
          },
          {
            question: 'Can I change plans?',
            answer:
              'Yes. Your firm admin can change plan from the portal; changes apply next cycle.',
          },
        ],
      },
    ],
    seo: {
      title: 'Pricing: Datascribe plans',
      description: 'Monthly medical record review plans with included pages and per-page overage.',
    },
  },
  resources: {
    slug: 'resources',
    title: 'Resources',
    hero: {
      eyebrow: 'Resources',
      heading: 'Guides for working with medical records',
      subheading: 'Practical notes for attorneys and paralegals.',
      ctas: [],
    },
    sections: [],
    seo: {
      title: 'Resources: guides on medical record review',
      description: 'Guides for attorneys and paralegals on medical chronologies and record review.',
    },
  },
  contact: {
    slug: 'contact',
    title: 'Contact',
    hero: {
      eyebrow: 'Contact',
      heading: 'Talk to us',
      subheading: 'Tell us about your firm and we’ll get back to you within one business day.',
      ctas: [],
    },
    contactForm: {
      kindLabel: 'I’d like to',
      demoOption: 'Book a demo',
      contactOption: 'Ask a question',
      nameLabel: 'Your name',
      companyLabel: 'Firm',
      emailLabel: 'Work email',
      phoneLabel: 'Phone (optional)',
      messageLabel: 'Message (optional)',
      submitLabel: 'Send',
      sendingLabel: 'Sending…',
      successMessage: 'Thanks, we’ve received your message and will be in touch shortly.',
    },
    sections: [],
    seo: {
      title: 'Contact Datascribe: book a demo',
      description: 'Talk to Datascribe about medical record review for your firm.',
    },
  },
};

export const DEFAULT_POSTS: Post[] = [
  {
    title: 'What makes a medical chronology useful in litigation',
    slug: 'useful-medical-chronology',
    excerpt: 'Five things attorneys look for in a chronology, and why page citations matter most.',
    author: 'Datascribe team',
    publishedAt: '2026-10-01T00:00:00.000Z',
    body: richText(
      'A chronology is only as useful as it is checkable. When opposing counsel challenges a date of service or a diagnosis, you need to find the page in seconds.',
      { h2: 'What to look for' },
      {
        ul: [
          'A page citation on every entry',
          'Provider and facility names spelled consistently',
          'Gaps in treatment called out, not hidden',
          'Pre-existing conditions noted separately',
          'Medications with dates started and stopped',
        ],
      },
      'This article is synthetic placeholder content for development.',
    ),
    seo: {
      title: 'What makes a medical chronology useful in litigation',
      description: 'Five things attorneys look for in a medical chronology.',
    },
  },
  {
    title: 'Requesting missing medical records: a checklist',
    slug: 'missing-records-checklist',
    excerpt: 'How to spot gaps in a record set before they become a problem at mediation.',
    author: 'Datascribe team',
    publishedAt: '2026-09-15T00:00:00.000Z',
    body: richText(
      'Missing records are one of the most common reasons a demand is delayed. A quick gap review at intake saves weeks later.',
      { h2: 'The checklist' },
      {
        ul: [
          'Compare referral letters against providers present in the set',
          'Look for imaging reports without the matching order',
          'Check billing records for dates of service with no clinical note',
        ],
      },
      'This article is synthetic placeholder content for development.',
    ),
    seo: null,
  },
  {
    title: 'How AI fits into medical record review',
    slug: 'ai-in-medical-record-review',
    excerpt: 'Where AI saves time, where people stay in charge, and how we keep the two apart.',
    author: 'Datascribe team',
    publishedAt: '2026-08-20T00:00:00.000Z',
    body: richText(
      'AI is good at reading quickly and drafting consistently. It is not accountable. That is why every AI-drafted entry in a Datascribe deliverable is checked by a person against the source page.',
      'This article is synthetic placeholder content for development.',
    ),
    seo: null,
  },
];
