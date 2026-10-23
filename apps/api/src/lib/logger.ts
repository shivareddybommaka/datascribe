import { pino, type Logger } from 'pino';

/**
 * Structured JSON logs. Redaction is a safety net only — code must never log PHI to begin with
 * (no request bodies, document text, patient names).
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'api' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.patientName',
        '*.text',
      ],
      censor: '[redacted]',
    },
  });
}
