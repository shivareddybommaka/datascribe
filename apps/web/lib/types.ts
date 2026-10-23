import type { ActivityType, LeadStage } from '@datascribe/shared/constants';

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    organizationId: string;
    orgType: 'client' | 'internal';
    mfaEnabled: boolean;
  };
  roles: string[];
  permissions: string[];
}

export interface UserRef {
  id: string;
  name: string;
  email: string;
}

export interface Lead {
  id: string;
  source: string;
  companyName: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  stage: LeadStage;
  ownerId: string | null;
  owner: UserRef | null;
  value: string | null;
  currency: string;
  nextFollowUpAt: string | null;
  lostReason: string | null;
  notes: string | null;
  convertedOrgId: string | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  organizationId: string | null;
  leadId: string | null;
  organization?: { id: string; name: string } | null;
  lead?: { id: string; companyName: string } | null;
}

export interface Activity {
  id: string;
  type: ActivityType;
  subject: string;
  body: string | null;
  dueAt: string | null;
  doneAt: string | null;
  userId: string;
  user?: UserRef;
  leadId: string | null;
  organizationId: string | null;
  createdAt: string;
  overdue?: boolean;
  lead?: { id: string; companyName: string } | null;
  organization?: { id: string; name: string } | null;
}

export interface LeadDetail extends Lead {
  contacts: Contact[];
  activities: Activity[];
  convertedOrg: { id: string; name: string; status: string } | null;
}

export interface Account {
  id: string;
  name: string;
  status: string;
  currency: string;
  plan: { id: string; name: string } | null;
  contactCount: number;
  userCount: number;
  leadId: string | null;
  createdAt: string;
}

export interface AccountDetail {
  id: string;
  name: string;
  status: string;
  currency: string;
  plan: { id: string; name: string; priceMonthly: string; currency: string } | null;
  createdAt: string;
  contacts: Contact[];
  activities: Activity[];
  users: { id: string; name: string; email: string; status: string; roles: string[] }[];
  leads: Lead[];
}

export interface PipelineSummary {
  byStage: { stage: LeadStage; count: number; value: string }[];
  openCount: number;
  openValue: string;
  conversionRate: number | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
}
