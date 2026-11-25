import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import { AUTOMATION_BUTTON_PAYLOAD_SEPARATOR } from './automation-run.constants.js';

/** The public ids a "sends your next step" button carries back. */
export interface AutomationButtonPayload {
  /** `aut_…`. */
  automationPublicId: string;
  /** `run_…`. */
  runPublicId: string;
  /**
   * `igm_…` — the message the button was on (the payload's third part, plan §30.8): her tap proves an
   * `unknown` message `sent` (plan §14). Absent on a two-part payload.
   */
  messagePublicId?: string | undefined;
}

/**
 * `<aut_…>::<run_…>::<igm_…>` — the postback payload of the hello's and the follow ask's buttons (the
 * channel's sending sub-domain builds them at send, ROUTE rows R19–R20; the message part since R44);
 * `<aut_…>::<run_…>` without a message.
 */
export function buildAutomationButtonPayload({
  automationPublicId,
  runPublicId,
  messagePublicId,
}: AutomationButtonPayload): string {
  const parts = [automationPublicId, runPublicId];
  if (messagePublicId !== undefined) parts.push(messagePublicId);
  return parts.join(AUTOMATION_BUTTON_PAYLOAD_SEPARATOR);
}

/**
 * Reads a postback payload as `<aut_…>::<run_…>`, optionally `::<igm_…>` (the intake calls it before
 * `handleButtonClick`); `null` when it is anything else — a payload this engine never sent.
 */
export function parseAutomationButtonPayload(payload: string): AutomationButtonPayload | null {
  const parts = payload.split(AUTOMATION_BUTTON_PAYLOAD_SEPARATOR);
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [automationPublicId, runPublicId, messagePublicId] = parts as [string, string, string?];
  if (!publicIdPatternFor('automation').test(automationPublicId)) return null;
  if (!publicIdPatternFor('automationRun').test(runPublicId)) return null;
  if (messagePublicId === undefined) return { automationPublicId, runPublicId };
  if (!publicIdPatternFor('instagramMessage').test(messagePublicId)) return null;
  return { automationPublicId, runPublicId, messagePublicId };
}
