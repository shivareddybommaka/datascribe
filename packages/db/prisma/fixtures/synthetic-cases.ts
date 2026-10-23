/**
 * SYNTHETIC DATA ONLY. Patient names follow Synthea's generated-name format (given/family names
 * with numeric suffixes) so they can never be mistaken for real people. M5 replaces these with
 * records generated locally by Synthea (see docs/DECISIONS.md D-010).
 */
export const SYNTHETIC_CASES = [
  {
    key: 'case-1',
    org: 'acme',
    matterName: 'Jacobs v. Riverside Logistics',
    reference: 'ACME-PI-0001',
    patientName: 'Ramiro608 Jacobs452',
    incidentDate: '2025-03-14',
    caseType: 'personal_injury',
    requested: ['index', 'chronology', 'summary'],
    priority: 'normal',
    status: 'draft',
  },
  {
    key: 'case-2',
    org: 'acme',
    matterName: 'Okuneva v. St. Mercy General',
    reference: 'ACME-MM-0002',
    patientName: 'Leida517 Okuneva707',
    incidentDate: '2024-11-02',
    caseType: 'med_mal',
    requested: ['index', 'chronology'],
    priority: 'high',
    status: 'submitted',
  },
  {
    key: 'case-3',
    org: 'harbor',
    matterName: 'Schmeler WC Claim',
    reference: 'HBR-WC-0003',
    patientName: 'Dewey930 Schmeler639',
    incidentDate: '2025-06-21',
    caseType: 'workers_comp',
    requested: ['chronology', 'summary'],
    priority: 'urgent',
    status: 'draft',
  },
] as const;
