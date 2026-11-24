import { beforeAll, describe, expect, it } from 'vitest';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import { emailConfirmLinkTemplate } from '@/infrastructure/mail/templates/email-confirm-link.template.js';

// Email copy comes from the locale files, as in the API and the worker.
beforeAll(async () => {
  await initializeI18nextForBackgroundWork();
});

describe('emailConfirmLinkTemplate', () => {
  it('renders the confirm link as a button and as text, with its lifetime', () => {
    const html = emailConfirmLinkTemplate({
      confirmUrl: 'https://app.example.com/confirm-email?token=abc_DEF-123',
      expiresInHours: 24,
    });

    expect(html).toContain('href="https://app.example.com/confirm-email?token=abc_DEF-123"');
    expect(html).toContain('24 hours');
    expect(html).toContain('Confirm your email');
  });

  it('HTML-escapes the link', () => {
    const html = emailConfirmLinkTemplate({
      confirmUrl: 'https://app.example.com/confirm-email?token=a&b="x"',
      expiresInHours: 24,
    });

    expect(html).toContain('token=a&amp;b=&quot;x&quot;');
    expect(html).not.toContain('b="x"');
  });

  it("renders the copy in the recipient's language", () => {
    const html = emailConfirmLinkTemplate({
      confirmUrl: 'https://app.example.com/confirm-email?token=abc',
      expiresInHours: 24,
      locale: 'es',
    });

    expect(html).toContain('<html lang="es">');
    expect(html).toContain('Confirma tu correo');
    expect(html).toContain('24 horas');
  });
});
