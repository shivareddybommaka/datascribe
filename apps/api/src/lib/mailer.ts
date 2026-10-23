import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Nodemailer over SMTP: Mailpit locally (nothing leaves the machine), SES SMTP in production. */
export function createSmtpMailer(opts: { host: string; port: number; from: string }): Mailer {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.port === 465,
  });
  return {
    async send(mail) {
      await transport.sendMail({ from: opts.from, ...mail });
    },
  };
}

/** Test double: keeps sent mail in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
  lastTo(to: string): Mail | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}

/** Extract the `token=` value from a mail body (tests and demos). */
export function tokenFromMail(mail: Mail | undefined): string {
  const match = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error('No token in mail');
  return match[1];
}
