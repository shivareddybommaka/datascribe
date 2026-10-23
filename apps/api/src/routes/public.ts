import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../context';
import { parse } from '../lib/validate';
import { Email, rateLimiter } from './auth';

/**
 * §5.1: website "Contact" and "Book a demo" forms create a CRM Lead and email the sales inbox.
 * Unauthenticated, so: per-IP rate limit, honeypot field, strict validation, no echo of input.
 */
export function publicRouter(deps: Deps): Router {
  const { prisma, mailer, env } = deps;
  const r = Router();
  const limit = rateLimiter(deps.rateLimits.windowMs, deps.rateLimits.publicPerWindow);

  r.post('/public/leads', limit, async (req, res) => {
    const body = parse(
      z.object({
        kind: z.enum(['contact', 'demo']),
        name: z.string().trim().min(1).max(200),
        company: z.string().trim().min(1).max(200),
        email: Email,
        phone: z.string().trim().max(40).optional(),
        message: z.string().trim().max(5000).optional(),
        /** honeypot: hidden in the form, so humans leave it empty */
        website: z.string().max(500).optional(),
      }),
      req.body,
    );

    // Bots get the same success response, but nothing is stored or sent.
    if (body.website) {
      req.log.info({ honeypot: true }, 'public lead dropped');
      res.status(202).json({ status: 'received' });
      return;
    }

    const lead = await prisma.lead.create({
      data: {
        source: body.kind === 'demo' ? 'website_demo' : 'website_contact',
        companyName: body.company,
        contactName: body.name,
        email: body.email,
        phone: body.phone || null,
        notes: body.message || null,
        stage: 'new',
      },
    });
    await req.audit({
      action: 'crm.lead.website',
      entity: 'Lead',
      entityId: lead.id,
      actorId: null,
      metadata: { kind: body.kind },
    });
    const lines = [
      `Company: ${body.company}`,
      `Name: ${body.name}`,
      `Email: ${body.email}`,
      body.phone ? `Phone: ${body.phone}` : null,
      body.message ? `\nMessage:\n${body.message}` : null,
      `\nOpen in CRM: ${env.APP_URL}/console/crm/leads/${lead.id}`,
    ];
    await mailer.send({
      to: env.SALES_INBOX,
      subject: `New website ${body.kind === 'demo' ? 'demo request' : 'enquiry'}: ${body.company}`,
      text: lines.filter(Boolean).join('\n'),
    });
    res.status(202).json({ status: 'received' });
  });

  /**
   * §5.1: the Pricing page reads plans from SubscriptionPlan so prices live in one place.
   * Public and read-only: active plans only, and only the fields a marketing page needs.
   */
  r.get('/public/plans', async (_req, res) => {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        priceMonthly: true,
        currency: true,
        includedPages: true,
        overagePerPage: true,
        features: true,
      },
    });
    res.setHeader('cache-control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({
      plans: plans.map((p) => ({
        ...p,
        // Decimals as fixed strings: no float rounding on money
        priceMonthly: p.priceMonthly.toFixed(2),
        overagePerPage: p.overagePerPage.toFixed(4),
        features: Array.isArray(p.features)
          ? p.features.filter((f): f is string => typeof f === 'string')
          : [],
      })),
    });
  });

  return r;
}
