import type {
  ActivityType,
  CaseStatus,
  CaseType,
  LeadStage,
  Priority,
} from '@datascribe/shared/constants';

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
  /** set while a super admin views the console as this (client) user, read-only (§4.4) */
  impersonation: {
    by: UserRef;
    organization: { id: string; name: string };
    expiresAt: string;
  } | null;
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

// ── Admin (M2) ──

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  status: 'invited' | 'active' | 'suspended';
  organization: { id: string; name: string; type: 'client' | 'internal'; status: string };
  roles: { key: string; name: string }[];
  mfaEnabled: boolean;
  emailVerified: boolean;
  mustResetPassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  group: 'internal' | 'client';
  locked: boolean;
  userCount: number;
  permissions: string[];
}

export interface OrgRow {
  id: string;
  name: string;
  type: 'client' | 'internal';
  status: 'active' | 'suspended' | 'closed';
  currency: string;
  plan: { id: string; name: string; priceMonthly: string } | null;
  userCount: number;
  enforceMfa: boolean;
  retentionDays: number;
  customPricing: { priceMonthly: string; includedPages: number; overagePerPage: string } | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  actor: UserRef | null;
  impersonator: UserRef | null;
  organization: { id: string; name: string } | null;
}

export interface EmailTemplate {
  key: string;
  label: string;
  description: string;
  group: 'account' | 'notification';
  variables: string[];
  required: string[];
  subject: string;
  body: string;
  customized: boolean;
  updatedAt: string | null;
}

export interface ProviderUsage {
  provider: string;
  calls: number;
  errors: number;
  errorRate: number;
  cacheHits: number;
  skipped: number;
  avgLatencyMs: number | null;
}

export interface MedicalStatus {
  provider: string;
  openFdaApiKeyConfigured: boolean;
  enabled: Record<string, boolean>;
  usage24h: ProviderUsage[];
}

// ── Billing (M8) ──

export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void' | 'overdue' | 'refunded';

export interface Plan {
  id: string;
  name: string;
  priceMonthly: string;
  currency: string;
  includedPages: number;
  overagePerPage: string;
  features: string[];
  active: boolean;
  sortOrder: number;
}

export interface Usage {
  periodStart: string;
  periodEnd: string;
  pagesUsed: number;
  includedPages: number;
  overagePages: number;
  percentUsed: number | null;
}

export interface SubscriptionRow {
  id: string;
  organizationId: string;
  organization?: { id: string; name: string };
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: Plan;
  usage?: Usage;
}

export interface Invoice {
  id: string;
  organizationId: string;
  organization?: { id: string; name: string };
  number: string;
  kind: 'subscription' | 'one_off';
  status: InvoiceStatus;
  currency: string;
  subtotal: string;
  taxLabel: string | null;
  taxRatePercent: string | null;
  tax: string;
  total: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  remindersSent: number;
  notes: string | null;
  createdAt: string;
}

export interface InvoiceLine {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface PaymentRow {
  id: string;
  invoiceId: string;
  gateway: string;
  gatewayRef: string;
  amount: string;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  refundedAmount: string;
  refundedAt: string | null;
  receiptUrl: string | null;
  createdAt: string;
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[];
  payments: PaymentRow[];
}

export interface InvoiceList extends Paged<Invoice> {
  outstanding: { currency: string; count: number; total: string }[];
}

// ── Client portal (M4) ──

export type Requestable = 'index' | 'chronology' | 'summary';

export interface CaseSummary {
  id: string;
  number: string;
  organizationId: string;
  matterName: string;
  reference: string | null;
  patientName: string;
  caseType: CaseType;
  priority: Priority;
  status: CaseStatus;
  dueAt: string | null;
  /** §5.4 SLA flag: red = overdue, amber = due in under 24 h (D-083) */
  sla: 'red' | 'amber' | null;
  submittedAt: string | null;
  createdAt: string;
}

// ── Staff case queue (M6) ──

export type AssignmentRole = 'case_manager' | 'summarizer' | 'qa_reviewer';

export interface StaffCaseRow extends CaseSummary {
  organization: { id: string; name: string };
  caseManager: { id: string; name: string } | null;
  summarizer: { id: string; name: string } | null;
  qaReviewer: { id: string; name: string } | null;
}

export interface AssignableStaff {
  role: AssignmentRole;
  items: { id: string; name: string; email: string; openCases: number }[];
}

export interface CaseDetail extends CaseSummary {
  organization: { id: string; name: string };
  incidentDate: string | null;
  requested: Requestable[];
  notes: string | null;
  createdBy: { id: string; name: string };
  createdById: string;
  deliveredAt: string | null;
  updatedAt: string;
  shares: UserRef[];
  timeline: { at: string; status: CaseStatus | null; action: string }[];
  can: {
    edit: boolean;
    submit: boolean;
    share: boolean;
    upload: boolean;
    deleteDocuments: boolean;
    message: boolean;
    internalMessages: boolean;
    assign?: boolean;
    reassignAny?: boolean;
    /** M6 part 4 (D-088): send the drafts to QA / record the QA decision */
    submitQa?: boolean;
    decideQa?: boolean;
  };
  caseManagerId?: string | null;
  summarizerId?: string | null;
  qaReviewerId?: string | null;
}

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error';

/** Source citation of a chronology entry or clinical event (§5.4). */
export interface Citation {
  documentId: string;
  fileName?: string;
  pageNumber: number;
}

export interface ChronologyEntry {
  eventId?: string;
  date: string | null;
  provider: string | null;
  facility: string | null;
  eventType: string | null;
  description: string;
  codes: { system: string; code: string; display: string }[];
  citation: Citation | null;
}

export interface IndexRow {
  documentId: string;
  fileName: string;
  pageFrom: number;
  pageTo: number;
  recordType: string;
  providers: string[];
  dateFrom: string | null;
  dateTo: string | null;
}

export type DeliverableContent =
  | { kind: 'chronology'; entries: ChronologyEntry[] }
  | { kind: 'index'; rows: IndexRow[]; totals: { documents: number; pages: number } }
  | { kind: 'summary'; sections: { heading: string; paragraphs: string[] }[]; provider?: string };

export interface WorkspaceDeliverable {
  id: string;
  type: 'index' | 'chronology' | 'summary' | 'report';
  version: number;
  status: 'draft' | 'in_qa' | 'changes_requested' | 'approved' | 'delivered';
  lockedAt: string | null;
  createdAt: string;
  /** Who saved this version; null = written by the pipeline (D-086). */
  editedBy: { id: string; name: string } | null;
  content: DeliverableContent;
}

/** GET /cases/:id/deliverables/:type/versions (D-086). */
export type DeliverableVersion = Omit<WorkspaceDeliverable, 'type' | 'content'>;

/** GET /cases/:id/workspace (M6 part 2, D-084). Staff only. */
export interface CaseWorkspace {
  case: CaseDetail;
  documents: {
    id: string;
    fileName: string;
    mimeType: string;
    pageCount: number | null;
    state: 'purged' | ScanStatus;
  }[];
  deliverables: WorkspaceDeliverable[];
  clinicalEvents: {
    id: string;
    documentId: string;
    pageNumber: number;
    eventDate: string | null;
    provider: string | null;
    facility: string | null;
    eventType: string | null;
    description: string;
    version: number;
  }[];
}

export interface DocumentPageText {
  documentId: string;
  pageNumber: number;
  pageCount: number | null;
  text: string | null;
  ocrConfidence: number | null;
  recordType: string | null;
}

export interface DocumentRow {
  id: string;
  caseId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  sha256: string | null;
  scanStatus: ScanStatus;
  state: 'uploading' | 'purged' | ScanStatus;
  uploadedAt: string | null;
  /** deleted by the retention job (D-128); the row stays as a tombstone */
  purgedAt: string | null;
  createdAt: string;
  uploadedBy: { id: string; name: string };
  partSize: number;
  partCount: number;
}

export interface UploadState extends DocumentRow {
  uploadedParts: number[];
  completed: boolean;
}

export interface DeliverableRow {
  id: string;
  type: 'index' | 'chronology' | 'summary' | 'report';
  version: number;
  status: string;
  createdAt: string;
}

export interface CaseMessage {
  id: string;
  body: string;
  internalOnly: boolean;
  createdAt: string;
  author: { id: string; name: string; staff: boolean };
}

export interface PortalDashboard {
  openCases: { status: CaseStatus; count: number }[];
  recentDeliverables: {
    id: string;
    type: DeliverableRow['type'];
    version: number;
    deliveredAt: string;
    case: { id: string; number: string; matterName: string };
  }[];
  usage: (Usage & { plan: { id: string; name: string }; cancelAtPeriodEnd: boolean }) | null;
  invoices: {
    items: Invoice[];
    outstanding: { currency: string; count: number; total: string }[];
  } | null;
}

export interface Firm {
  id: string;
  name: string;
  status: string;
  currency: string;
  plan: { id: string; name: string } | null;
  userCount: number;
  enforceMfa: boolean;
}

export interface FirmUser {
  id: string;
  name: string;
  email: string;
  status: 'invited' | 'active' | 'suspended';
  roles: { key: string; name: string }[];
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: { key: string; name: string };
  expiresAt: string;
  createdAt: string;
}
