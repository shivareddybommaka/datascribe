import type { AuthContext } from '../auth/context';
import type { AuditEntry } from '../lib/audit';

declare global {
  namespace Express {
    interface Request {
      /** set by `authenticate` */
      auth?: AuthContext;
      /** set by the audit middleware on every request */
      audit: (entry: AuditEntry) => Promise<void>;
    }
  }
}

export {};
