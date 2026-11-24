import { DEFAULT_LANGUAGE, type SupportedLanguage } from '@/shared/constants/i18n.constants.js';
import { baseTemplate, translateMailText } from './base.template.js';
import { escapeHtml } from './escape-html.util.js';

/** Template variables for {@link emailConfirmLinkTemplate} — the confirm link, its lifetime in hours and the recipient's language. */
export interface EmailConfirmLinkTemplateData {
  confirmUrl: string;
  expiresInHours: number;
  locale?: SupportedLanguage;
}

/**
 * Renders the confirm-your-email HTML email (wrapped in `baseTemplate`) — feat-instagram-dm-sending
 * UN6. Emitted from the auth-method event handlers when a signed-in person asks for the link.
 *
 * @remarks
 * The `confirmUrl` is server-built (`<FRONTEND_URL>/confirm-email?token=<token>`) but still passed
 * through {@link escapeHtml} so a `&` in the address is encoded for the HTML attribute.
 */
export function emailConfirmLinkTemplate(data: EmailConfirmLinkTemplateData): string {
  const locale = data.locale ?? DEFAULT_LANGUAGE;
  const confirmUrl = escapeHtml(data.confirmUrl);
  const expiresInHours = data.expiresInHours;

  return baseTemplate({
    locale,
    title: translateMailText({ key: 'emailConfirmHeading', locale }),
    preheader: translateMailText({
      key: 'emailConfirmPreheader',
      locale,
      values: { expiresInHours },
    }),
    body: `
      <h1>${translateMailText({ key: 'emailConfirmHeading', locale })}</h1>
      <p>${translateMailText({ key: 'emailConfirmBody', locale, values: { expiresInHours } })}</p>
      <p style="text-align: center; margin: 32px 0;">
        <a href="${confirmUrl}" class="button">${translateMailText({ key: 'emailConfirmButton', locale })}</a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">${translateMailText({ key: 'ignoreIfNotRequested', locale })}</p>
      <p style="font-size: 13px; color: #6b7280;">${translateMailText({ key: 'copyUrlPrompt', locale })}</p>
      <p style="font-size: 12px; color: #9ca3af; word-break: break-all;">${confirmUrl}</p>
    `,
  });
}
