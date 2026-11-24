import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import i18next from 'i18next';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  type InstagramMessageRecipient,
  type InstagramOutgoingMessage,
  type InstagramUserProfile,
  readInstagramUserProfile,
  replyToInstagramComment,
  sendInstagramMessage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { InstagramAutomationAccountAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import {
  AUTOMATION_MESSAGE_KEYS,
  AUTOMATION_MESSAGE_LANGUAGE,
  AUTOMATION_SEND_PAUSE_MAX_MILLISECONDS,
  AUTOMATION_SEND_PAUSE_MIN_MILLISECONDS,
  type AutomationCommentLogErrorType,
  type AutomationRunSendingMessageKind,
} from './automation-run.constants.js';
import {
  type AutomationDefaultTexts,
  type AutomationMessageSource,
  type ComposedAutomationMessage,
  buildAutomationButtonPayload,
  buildInstagramProfileUrl,
  composeAutomationMessage,
} from './automation-run-message.util.js';
import type { AutomationRandomSource } from './automation-public-reply-safety.service.js';

/**
 * The three Instagram client calls the engine makes (K10) — injectable for tests (a fake client).
 *
 * @remarks
 * Production uses the one Instagram client (`src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts`); the
 * engine never calls Instagram any other way.
 */
export interface AutomationInstagramClient {
  sendInstagramMessage: typeof sendInstagramMessage;
  replyToInstagramComment: typeof replyToInstagramComment;
  readInstagramUserProfile: typeof readInstagramUserProfile;
}

/** The real client of `src/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.ts`. */
const INSTAGRAM_CLIENT: AutomationInstagramClient = {
  sendInstagramMessage,
  replyToInstagramComment,
  readInstagramUserProfile,
};

/**
 * A pause before a send (K10) — `setTimeout` in production, instant in tests.
 *
 * @remarks
 * Awaited outside any database context, like the send it precedes.
 */
export type AutomationPause = (milliseconds: number) => Promise<void>;

/**
 * How one send ended (AU19, 3.B.9):
 * - `delivered` — Instagram took it;
 * - `temporary` — not delivered and worth a retry (a throttle, a 5xx other than 502 and 504, an open
 *   circuit, a connection refused before anything was sent) — the claim is cleared and the error
 *   rethrown, or on the last attempt the run fails;
 * - `refused` — not delivered, never will be (the person blocks messages, outside the messaging
 *   window, the comment is gone): the step fails;
 * - `token` — the token is dead: the account is marked broken and the step fails;
 * - `unknown` — it may have been delivered (a timeout after the request left, an HTTP 502 or 504
 *   (D55), an error of our own): the claim stays and the step fails, never re-sent (AQ5).
 *
 * @remarks
 * The engine records each outcome in its own short unit of work (AU19 step c).
 */
export type AutomationSendResult =
  | { outcome: 'delivered' }
  | { outcome: 'temporary'; error: unknown; errorType: AutomationCommentLogErrorType }
  | { outcome: 'refused'; error: MetaGraphApiError }
  | { outcome: 'token'; error: MetaGraphApiError }
  | { outcome: 'unknown'; error: unknown; errorType: AutomationCommentLogErrorType };

/**
 * How a follow read ended (AU18 step 3): read, a dead token, or a failure worth a retry.
 *
 * @remarks
 * A read is safe to repeat, so it has no "unknown" outcome; a refusal reads as `isFollowing`
 * `null` (the follow request goes).
 */
export type AutomationFollowReadResult =
  | { outcome: 'read'; isFollowing: boolean | null; profile: InstagramUserProfile | null }
  | { outcome: 'token'; error: MetaGraphApiError }
  | { outcome: 'temporary'; error: unknown; errorType: AutomationCommentLogErrorType };

/** Node's codes for a connection that never opened — nothing reached Instagram. */
const NEVER_CONNECTED_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * The answers of a gateway that lost Instagram's own — Bad Gateway, Gateway Timeout: the message may
 * have been delivered behind it, as in a timeout (D55).
 */
const AMBIGUOUS_GATEWAY_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 504]);

/** Whether `error` (or a cause under it) is a connection that never opened. */
function isNeverConnected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_CONNECTED_ERROR_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Classifies a failed send (AU19, 3.B.9) — pure: an Instagram answer (`auth` → `token`; `refused`
 * → `refused`; `throttled` or a 5xx → `temporary`), an open circuit or a connection that never
 * opened → `temporary` (nothing was sent), anything else — a timeout, a 502 or 504 (D55), a reset
 * connection, an error of our own — → `unknown` (it may have gone; never re-sent, AQ5).
 *
 * @remarks
 * A connection that never opened is read from the error's cause chain (`ECONNREFUSED`,
 * `ENOTFOUND`, `EAI_AGAIN`); the outbound layer otherwise files it with every other `network`
 * failure.
 */
export function classifyAutomationSendFailure(
  error: unknown,
): Exclude<AutomationSendResult, { outcome: 'delivered' }> {
  if (error instanceof CircuitBreakerOpenError) {
    return { outcome: 'temporary', error, errorType: 'network' };
  }
  if (!(error instanceof MetaGraphApiError)) {
    return { outcome: 'unknown', error, errorType: 'code' };
  }
  switch (error.errorClass) {
    case 'auth':
      return { outcome: 'token', error };
    case 'refused':
      return { outcome: 'refused', error };
    case 'throttled':
      return { outcome: 'temporary', error, errorType: 'instagram_api' };
    case 'outage':
      if (error.status !== undefined && AMBIGUOUS_GATEWAY_HTTP_STATUSES.has(error.status)) {
        return { outcome: 'unknown', error, errorType: 'network' };
      }
      if (error.category === 'http_5xx') {
        return { outcome: 'temporary', error, errorType: 'instagram_api' };
      }
      if (error.category === 'circuit_open' || isNeverConnected(error)) {
        return { outcome: 'temporary', error, errorType: 'network' };
      }
      return { outcome: 'unknown', error, errorType: 'network' };
  }
}

/**
 * Composes and sends a run's messages (routes-final § 3.B, AUC10): the DMs in Instagram's wire
 * shape with the English defaults (AU22), the public reply, and the follow read — every Instagram
 * call of the run engine, outside any database context (K10, AU19).
 *
 * @remarks
 * Algorithm: before each send a random pause of 200–1000 ms (K10); a question whose quick reply
 * Instagram refuses (code 100, subcode 2534015) goes again as plain text under the same claim — a
 * refusal means it was not delivered (AU22). Each failure is classified once
 * ({@link classifyAutomationSendFailure}).
 *
 * Failure modes: none thrown — every outcome is returned for the engine to record.
 *
 * Side effects: Instagram calls only; the claim before and the record after are the engine's
 * short units of work (AU19). Never logs a message text (K7).
 */
export class AutomationRunMessageService {
  constructor(
    private readonly instagramClient: AutomationInstagramClient = INSTAGRAM_CLIENT,
    private readonly pause: AutomationPause = (milliseconds) => delay(milliseconds),
    private readonly drawInteger: AutomationRandomSource = (maxExclusive) =>
      randomInt(maxExclusive),
  ) {}

  /** The English default texts (AU22), read through i18next — every DM is in English at launch. */
  readDefaultTexts(): AutomationDefaultTexts {
    const options = { lng: AUTOMATION_MESSAGE_LANGUAGE, interpolation: { escapeValue: false } };
    return {
      emailQuestion: i18next.t(AUTOMATION_MESSAGE_KEYS.emailQuestion, options),
      phoneQuestion: i18next.t(AUTOMATION_MESSAGE_KEYS.phoneQuestion, options),
      invalidEmail: i18next.t(AUTOMATION_MESSAGE_KEYS.invalidEmail, options),
      buttonTemplateText: i18next.t(AUTOMATION_MESSAGE_KEYS.buttonTemplateText, options),
      linkButtonTitle: i18next.t(AUTOMATION_MESSAGE_KEYS.linkButtonTitle, options),
    };
  }

  /**
   * One DM of a run, composed (AU18, schema-routes § 10): the button payload `<aut_…>::<run_…>`
   * and the account's profile link filled in.
   */
  composeMessage({
    messageKind,
    automation,
    automationPublicId,
    runPublicId,
    accountUsername,
  }: {
    messageKind: AutomationRunSendingMessageKind;
    automation: AutomationMessageSource;
    automationPublicId: string;
    runPublicId: string;
    accountUsername: string | null;
  }): ComposedAutomationMessage {
    return composeAutomationMessage({
      messageKind,
      automation,
      buttonPayload: buildAutomationButtonPayload({ automationPublicId, runPublicId }),
      profileUrl: buildInstagramProfileUrl(accountUsername ?? ''),
      defaults: this.readDefaultTexts(),
    });
  }

  /**
   * Sends one claimed DM (AU19 step b): the pause, the send, and — when Instagram refuses the
   * question's quick reply — the plain-text fallback under the same claim.
   */
  async sendDirectMessage({
    access,
    recipient,
    composed,
    requestId,
  }: {
    access: InstagramAutomationAccountAccess;
    recipient: InstagramMessageRecipient;
    composed: ComposedAutomationMessage;
    requestId: string | undefined;
  }): Promise<AutomationSendResult> {
    const result = await this.sendOnce({ access, recipient, message: composed.message, requestId });
    if (
      result.outcome === 'refused' &&
      result.error.isQuickReplyRefused &&
      composed.plainTextFallback !== null
    ) {
      return this.sendOnce({
        access,
        recipient,
        message: composed.plainTextFallback,
        requestId,
      });
    }
    return result;
  }

  /** Sends one claimed public reply under the comment (AU18 step 2, AU19 step b). */
  async sendPublicReply({
    access,
    instagramCommentId,
    text,
    requestId,
  }: {
    access: InstagramAutomationAccountAccess;
    instagramCommentId: string;
    text: string;
    requestId: string | undefined;
  }): Promise<AutomationSendResult> {
    const encryptedAccessToken = access.encryptedAccessToken;
    if (encryptedAccessToken === null) {
      return { outcome: 'unknown', error: new Error('no access token'), errorType: 'code' };
    }
    await this.pauseBeforeSend();
    try {
      await this.instagramClient.replyToInstagramComment({
        encryptedAccessToken,
        instagramCommentId,
        text,
        requestId,
      });
      return { outcome: 'delivered' };
    } catch (error) {
      return classifyAutomationSendFailure(error);
    }
  }

  /**
   * Reads whether the contact follows the account (AU18 step 3) — `is_user_follow_business`, with
   * the profile it came with. A refusal (Instagram will not show this person) reads as "unknown"
   * (`isFollowing` `null`), so the follow request goes; a read is safe to repeat, so a timeout or a
   * gateway's 502 or 504 is `temporary`.
   */
  async readFollowStatus({
    access,
    instagramUserId,
    requestId,
  }: {
    access: InstagramAutomationAccountAccess;
    instagramUserId: string;
    requestId: string | undefined;
  }): Promise<AutomationFollowReadResult> {
    const encryptedAccessToken = access.encryptedAccessToken;
    if (encryptedAccessToken === null) {
      return { outcome: 'temporary', error: new Error('no access token'), errorType: 'code' };
    }
    try {
      const profile = await this.instagramClient.readInstagramUserProfile({
        encryptedAccessToken,
        instagramScopedUserId: instagramUserId,
        requestId,
      });
      return { outcome: 'read', isFollowing: profile.isUserFollowingBusiness, profile };
    } catch (error) {
      if (error instanceof MetaGraphApiError && error.errorClass === 'auth') {
        return { outcome: 'token', error };
      }
      if (error instanceof MetaGraphApiError && error.errorClass === 'refused') {
        return { outcome: 'read', isFollowing: null, profile: null };
      }
      if (error instanceof MetaGraphApiError && error.category === 'http_5xx') {
        return { outcome: 'temporary', error, errorType: 'instagram_api' };
      }
      const failure = classifyAutomationSendFailure(error);
      return {
        outcome: 'temporary',
        error,
        errorType: 'errorType' in failure ? failure.errorType : 'instagram_api',
      };
    }
  }

  /** The pause, one send, its outcome. */
  private async sendOnce({
    access,
    recipient,
    message,
    requestId,
  }: {
    access: InstagramAutomationAccountAccess;
    recipient: InstagramMessageRecipient;
    message: InstagramOutgoingMessage;
    requestId: string | undefined;
  }): Promise<AutomationSendResult> {
    const encryptedAccessToken = access.encryptedAccessToken;
    if (encryptedAccessToken === null) {
      return { outcome: 'unknown', error: new Error('no access token'), errorType: 'code' };
    }
    await this.pauseBeforeSend();
    try {
      await this.instagramClient.sendInstagramMessage({
        encryptedAccessToken,
        instagramUserId: access.instagramUserId,
        recipient,
        message,
        requestId,
      });
      return { outcome: 'delivered' };
    } catch (error) {
      return classifyAutomationSendFailure(error);
    }
  }

  /** A random 200–1000 ms pause before each send, so replies look human (K10). */
  private async pauseBeforeSend(): Promise<void> {
    await this.pause(
      AUTOMATION_SEND_PAUSE_MIN_MILLISECONDS +
        this.drawInteger(
          AUTOMATION_SEND_PAUSE_MAX_MILLISECONDS - AUTOMATION_SEND_PAUSE_MIN_MILLISECONDS + 1,
        ),
    );
  }
}
