import { publicIdPatternFor } from '@/shared/utils/identity/public-id.util.js';
import { AUTOMATION_BUTTON_PAYLOAD_SEPARATOR } from './automation-run.constants.js';

/** The two public ids a "sends your next step" button carries back. */
export interface AutomationButtonPayload {
  /** `aut_…`. */
  automationPublicId: string;
  /** `run_…`. */
  runPublicId: string;
}

/**
 * `<aut_…>::<run_…>` — the postback payload of the hello's and the follow ask's buttons (the channel's
 * sending sub-domain builds them at send, ROUTE rows R19–R20).
 */
export function buildAutomationButtonPayload({
  automationPublicId,
  runPublicId,
}: AutomationButtonPayload): string {
  return `${automationPublicId}${AUTOMATION_BUTTON_PAYLOAD_SEPARATOR}${runPublicId}`;
}

/**
 * Reads a postback payload as `<aut_…>::<run_…>` (the intake calls it before `handleButtonClick`);
 * `null` when it is anything else — a payload this engine never sent.
 */
export function parseAutomationButtonPayload(payload: string): AutomationButtonPayload | null {
  const parts = payload.split(AUTOMATION_BUTTON_PAYLOAD_SEPARATOR);
  if (parts.length !== 2) return null;
  const [automationPublicId, runPublicId] = parts as [string, string];
  if (!publicIdPatternFor('automation').test(automationPublicId)) return null;
  if (!publicIdPatternFor('automationRun').test(runPublicId)) return null;
  return { automationPublicId, runPublicId };
}
