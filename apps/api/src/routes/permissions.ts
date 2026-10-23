import { Router } from 'express';
import { authenticate, requirePermission } from '../auth/middleware';
import type { Deps } from '../context';

/** GET /permissions: the catalogue for the admin role matrix (M2). Users-and-roles module. */
export function permissionsRouter(deps: Deps): Router {
  const r = Router();
  r.get(
    '/permissions',
    authenticate(deps),
    requirePermission('users', 'view'),
    async (_req, res) => {
      const items = await deps.prisma.permission.findMany({
        orderBy: [{ module: 'asc' }, { action: 'asc' }, { scope: 'asc' }],
        select: { id: true, module: true, action: true, scope: true },
      });
      res.json({ items });
    },
  );
  return r;
}
