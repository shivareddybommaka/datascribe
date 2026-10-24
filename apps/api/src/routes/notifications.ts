import { adminRules } from '@datascribe/db/notifications';
import {
  NOTIFICATION_CATALOG,
  isNotificationType,
  renderNotification,
  typesFor,
} from '@datascribe/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAuth } from '../auth/middleware';
import type { AuthContext } from '../auth/context';
import type { Deps } from '../context';
import { badRequest, notFound } from '../lib/errors';
import { parse } from '../lib/validate';

/**
 * In-app notifications and preferences (§5.8, M9, D-091). Every authenticated user, no module
 * permission: a user only ever reads their own rows, and only those created in their current
 * organisation, so a client can never see another firm's notifications. Impersonation is
 * read-only (D-061): the super admin sees the bell but can't mark anything read.
 */
export function notificationsRouter(deps: Deps): Router {
  const { prisma } = deps;
  const r = Router();
  r.use('/notifications', authenticate(deps));

  const mine = (auth: AuthContext) => ({
    userId: auth.user.id,
    organizationId: auth.user.organizationId,
    inApp: true,
  });
  const area = (auth: AuthContext) => (auth.user.orgType === 'client' ? 'portal' : 'console');

  const ListQuery = z.object({
    unread: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** id of the last item of the previous page */
    cursor: z.string().min(1).max(64).optional(),
  });

  r.get('/notifications', async (req, res) => {
    const auth = requireAuth(req);
    const q = parse(ListQuery, req.query);
    const rows = await prisma.notification.findMany({
      where: { ...mine(auth), ...(q.unread === 'true' ? { readAt: null } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: { id: true, type: true, payload: true, readAt: true, createdAt: true },
    });
    const page = rows.slice(0, q.limit);
    res.json({
      items: page.map((n) => ({
        id: n.id,
        type: n.type,
        ...renderNotification(n.type, n.payload, area(auth)),
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    });
  });

  r.get('/notifications/unread-count', async (req, res) => {
    const auth = requireAuth(req);
    const count = await prisma.notification.count({ where: { ...mine(auth), readAt: null } });
    res.json({ count });
  });

  r.post('/notifications/read-all', async (req, res) => {
    const auth = requireAuth(req);
    const { count } = await prisma.notification.updateMany({
      where: { ...mine(auth), readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ updated: count });
  });

  r.post('/notifications/:id/read', async (req, res) => {
    const auth = requireAuth(req);
    const id = String(req.params.id);
    // scoped update: another user's (or firm's) id behaves exactly like a missing one
    const { count } = await prisma.notification.updateMany({
      where: { id, ...mine(auth) },
      data: { readAt: new Date() },
    });
    if (count === 0) throw notFound();
    const row = await prisma.notification.findUniqueOrThrow({
      where: { id },
      select: { id: true, readAt: true },
    });
    res.json(row);
  });

  // ── Preferences ──────────────────────────────────────────────────
  async function preferences(auth: AuthContext) {
    const stored = await prisma.notificationPreference.findMany({
      where: { userId: auth.user.id },
    });
    const byType = new Map(stored.map((p) => [p.type, p]));
    const rules = await adminRules(prisma);
    return typesFor(auth.user.orgType).map((type) => {
      const entry = NOTIFICATION_CATALOG[type];
      const pref = byType.get(type);
      const rule = entry.settingsKey ? rules[entry.settingsKey] : undefined;
      return {
        type,
        label: entry.label,
        description: entry.description,
        category: entry.category,
        critical: entry.critical,
        email: entry.critical ? true : (pref?.email ?? entry.defaultEmail),
        inApp: entry.critical ? true : (pref?.inApp ?? true),
        // switched off for everyone by an admin (Settings → Notifications)
        emailDisabledByAdmin: rule ? !rule.email : false,
        inAppDisabledByAdmin: rule ? !rule.inApp : false,
      };
    });
  }

  r.get('/notifications/preferences', async (req, res) => {
    res.json({ items: await preferences(requireAuth(req)) });
  });

  const PrefsBody = z.object({
    items: z
      .array(
        z
          .object({
            type: z.string().min(1).max(64),
            email: z.boolean().optional(),
            inApp: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  });

  r.put('/notifications/preferences', async (req, res) => {
    const auth = requireAuth(req);
    const body = parse(PrefsBody, req.body);
    const allowed = new Set<string>(typesFor(auth.user.orgType));
    for (const item of body.items) {
      if (!isNotificationType(item.type) || !allowed.has(item.type)) {
        throw badRequest('unknown_type', `Unknown notification type: ${item.type}`);
      }
      const entry = NOTIFICATION_CATALOG[item.type];
      if (entry.critical && (item.email === false || item.inApp === false)) {
        throw badRequest('cannot_mute_critical', `${entry.label} notifications can't be muted`);
      }
    }
    const current = new Map((await preferences(auth)).map((p) => [p.type, p]));
    await prisma.$transaction(
      body.items.map((item) => {
        const now = current.get(item.type as never)!;
        const email = item.email ?? now.email;
        const inApp = item.inApp ?? now.inApp;
        return prisma.notificationPreference.upsert({
          where: { userId_type: { userId: auth.user.id, type: item.type } },
          update: { email, inApp },
          create: { userId: auth.user.id, type: item.type, email, inApp },
        });
      }),
    );
    await req.audit({
      action: 'notification.preferences.updated',
      entity: 'User',
      entityId: auth.user.id,
      metadata: { types: body.items.map((i) => i.type).sort() },
    });
    res.json({ items: await preferences(auth) });
  });

  return r;
}
