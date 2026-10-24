import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { isSuperAdmin } from '../../auth/grants';
import { authenticate, requireAuth } from '../../auth/middleware';
import { revoked } from '../../auth/session';
import type { Deps } from '../../context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { ACCESS_TOKEN_TTL_SECONDS, randomToken, sha256, signAccessToken } from '../../lib/tokens';

/**
 * §4.4 read-only impersonation (D-061). A super admin gets an access token for a client user:
 * the token carries `imp`, its session row records the impersonator, every non-GET request is
 * refused (auth/middleware.ts), and start/stop are audited with AuditLog.impersonatorId. No
 * refresh token is issued, so it ends with the access token (15 minutes) or on "stop".
 */
export function impersonationRouter(deps: Deps): Router {
  const { prisma, env } = deps;
  const r = Router();
  r.use('/admin/impersonate', authenticate(deps));

  r.post('/admin/impersonate/stop', async (req, res) => {
    const auth = requireAuth(req);
    if (!auth.impersonatorId) throw badRequest('not_impersonating', 'Not impersonating anyone');
    await prisma.session.update({
      where: { id: auth.sessionId },
      data: revoked('impersonation_ended'),
    });
    await req.audit({
      action: 'admin.impersonation.stopped',
      entity: 'User',
      entityId: auth.user.id,
      organizationId: auth.user.organizationId,
      metadata: { sessionId: auth.sessionId },
    });
    res.status(204).end();
  });

  r.post('/admin/impersonate/:userId', async (req, res) => {
    const auth = requireAuth(req);
    if (!isSuperAdmin(auth) || auth.user.orgType !== 'internal') {
      throw forbidden('Only a super admin can view as another user');
    }
    const target = await prisma.user.findUnique({
      where: { id: String(req.params.userId) },
      include: { organization: { select: { id: true, name: true, type: true, status: true } } },
    });
    if (!target) throw notFound();
    if (target.organization.type !== 'client') {
      throw forbidden('Only client users can be impersonated');
    }
    if (target.status !== 'active' || target.organization.status !== 'active') {
      throw badRequest('user_inactive', 'That user or their firm is not active');
    }

    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
    const session = await prisma.session.create({
      data: {
        userId: target.id,
        // never handed out: impersonation sessions can't be refreshed
        refreshTokenHash: sha256(randomToken()),
        familyId: randomUUID(),
        surface: 'portal',
        impersonatorId: auth.user.id,
        lastUsedAt: new Date(),
        expiresAt,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
      },
    });
    await req.audit({
      action: 'admin.impersonation.started',
      entity: 'User',
      entityId: target.id,
      actorId: target.id,
      impersonatorId: auth.user.id,
      organizationId: target.organizationId,
      metadata: { sessionId: session.id },
    });
    const accessToken = signAccessToken(
      { sub: target.id, sid: session.id, imp: auth.user.id },
      env.JWT_ACCESS_SECRET,
    );
    res.status(201).json({
      accessToken,
      expiresAt,
      user: {
        id: target.id,
        name: target.name,
        email: target.email,
        organization: { id: target.organization.id, name: target.organization.name },
      },
    });
  });

  return r;
}
