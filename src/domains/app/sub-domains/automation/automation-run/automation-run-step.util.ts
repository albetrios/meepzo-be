import type {
  AutomationMessage,
  AutomationSteps,
} from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import {
  AUTOMATION_SHE_MESSAGED_FIRST_TRIGGER_TYPES,
  type AutomationTriggerType,
} from '@/domains/app/sub-domains/automation/automation.constants.js';
import { AUTOMATION_RUN_ONCE_KEY_MAX_LENGTH } from './automation-run.constants.js';

/**
 * Draws a whole number in `[0, maxExclusive)` — `crypto.randomInt` in production, a fixed source in
 * tests (the version pick, the public reply's draw, the wording).
 *
 * @remarks
 * Injected into the run engine so a test fixes every draw.
 */
export type AutomationRandomSource = (maxExclusive: number) => number;

/** The plan's feature switches the engine reads per job (AU26, D57); `null` = no readable plan. */
export type AutomationPlanSwitches = Readonly<Record<string, boolean>> | null;

/** Whether the plan switch is on (AU26): an unreadable plan has no PRO part. */
export function isPlanSwitchOn({
  switches,
  feature,
}: {
  switches: AutomationPlanSwitches;
  feature: string;
}): boolean {
  return switches?.[feature] === true;
}

/** The hello step when it is on with at least one version (D30). */
export function helloStepOf(steps: AutomationSteps) {
  const hello = steps.hello;
  return hello?.on === true && hello.versions.length > 0 ? hello : null;
}

/** The follow ask when it is on with at least one version (D31). */
export function followStepOf(steps: AutomationSteps) {
  const follow = steps.follow;
  return follow?.on === true && follow.versions.length > 0 ? follow : null;
}

/** The email or phone ask when it is on, has a wording and the plan holds its PRO switch (AU26). */
export function questionStepOf({
  steps,
  part,
  switches,
}: {
  steps: AutomationSteps;
  part: 'email' | 'phone';
  switches: AutomationPlanSwitches;
}) {
  const question = steps[part];
  if (question?.on !== true || question.wordings.length === 0) return null;
  return isPlanSwitchOn({ switches, feature: part === 'email' ? 'email_ask' : 'phone_ask' })
    ? question
    : null;
}

/** The message list (always on, D29). */
export function messagesOf(steps: AutomationSteps): readonly AutomationMessage[] {
  return steps.messages ?? [];
}

/** The tags the tag step adds when it is on (D45). */
export function tagsOf(steps: AutomationSteps): readonly string[] {
  return steps.tags?.on === true ? steps.tags.list : [];
}

/**
 * Whether a hello version carries a "sends your next step" button — only then does the run wait for
 * her tap (a link button sends no tap, plan §5.6 rule 1).
 */
export function helloHasNextButton({
  steps,
  versionNumber,
}: {
  steps: AutomationSteps;
  versionNumber: number;
}): boolean {
  const version = steps.hello?.versions[versionNumber - 1] ?? steps.hello?.versions[0];
  return version?.buttons.some((button) => button.action === 'next') ?? false;
}

/**
 * A version picked at random for a run's start (AU27, D36): 1 without the plan's `message_versions`
 * switch or with one version, else one of `count`.
 */
export function pickVersionNumber({
  count,
  switches,
  drawInteger,
}: {
  count: number;
  switches: AutomationPlanSwitches;
  drawInteger: AutomationRandomSource;
}): number {
  if (count <= 1 || !isPlanSwitchOn({ switches, feature: 'message_versions' })) return 1;
  return drawInteger(count) + 1;
}

/** A wording at random, never the last one sent when there are two or more (plan §5.8). */
export function pickWordingNumber({
  count,
  lastWordingNumber,
  drawInteger,
}: {
  count: number;
  lastWordingNumber: number | null;
  drawInteger: AutomationRandomSource;
}): number {
  if (count <= 1) return 1;
  const others = Array.from({ length: count }, (_, index) => index + 1).filter(
    (wording) => wording !== lastWordingNumber,
  );
  return others[drawInteger(others.length)] ?? 1;
}

/** The upload public ids a list message sends (content by reference, AU35). */
export function uploadPublicIdsOf(message: AutomationMessage): string[] {
  switch (message.kind) {
    case 'text':
      return message.image_upload_id === undefined ? [] : [message.image_upload_id];
    case 'image':
    case 'audio':
    case 'file':
      return [message.upload_id];
    case 'cards':
      return message.cards.flatMap((card) =>
        card.image_upload_id === undefined ? [] : [card.image_upload_id],
      );
    case 'quick_replies':
    case 'post':
      return [];
  }
}

/** Whether she messaged first for this way to start — only these get a nudge (D30). */
export function isSheMessagedFirst(triggerType: AutomationTriggerType): boolean {
  return AUTOMATION_SHE_MESSAGED_FIRST_TRIGGER_TYPES.includes(triggerType);
}

/** The organization's day (`YYYY-MM-DD`) in its time zone — the `<date>` of a once key (AU22). */
export function organizationDayOf({ at, timeZone }: { at: Date; timeZone: string }): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** What a once key is built from (AU22, D13, D65). */
export interface AutomationOnceKeyInput {
  triggerType: AutomationTriggerType;
  /** The account's "once per person per post" switch (D65): off = the event's own id. */
  isOncePerPersonPerPost: boolean;
  /** "No other automation answered" — `every_time` keys by her message (D44). */
  defaultReplyMode: string | null;
  /** The organization's day of the event. */
  day: string;
  /** The event's own id (comment, message, postback or tag event). */
  eventId: string;
  mediaId?: string | null;
  storyId?: string | null;
  adId?: string | null;
  tag?: string | null;
}

/**
 * The once key of a run's start (AU22, plan §4.2): the media id, `live:…`, `story:…`, `mention:…`,
 * `dm:<date>`, `first`, `share:…`, `starter:<date>`, `ref:<date>`, `default:<date>` or
 * `default:<message id>`, `ad:<ad id>`, `tag:<tag>:<event id>` / `untag:…`; with the account's switch
 * off ("every time", D65) the event's own id is appended or used instead. At most 255 characters.
 *
 * @remarks
 * Pure. "First message" stays once ever; "no other automation answered" keeps its own choice; tag
 * keys are per event already.
 */
export function buildOnceKey(input: AutomationOnceKeyInput): string {
  const everyTime = !input.isOncePerPersonPerPost;
  const withEvent = (base: string) => (everyTime ? `${base}:${input.eventId}` : base);
  let key: string;
  switch (input.triggerType) {
    case 'comment':
    case 'ad_comment':
      key = withEvent(input.mediaId ?? 'post');
      break;
    case 'live_comment':
      key = withEvent(`live:${input.mediaId ?? 'live'}`);
      break;
    case 'story_reply':
      key = withEvent(`story:${input.storyId ?? 'any'}`);
      break;
    case 'story_mention':
      key = withEvent(`mention:${input.storyId ?? 'any'}`);
      break;
    case 'story_repost':
      key = withEvent(`repost:${input.storyId ?? 'any'}`);
      break;
    case 'dm_keyword':
      key = everyTime ? `dm:${input.eventId}` : `dm:${input.day}`;
      break;
    case 'first_message':
      key = 'first';
      break;
    case 'shared_post':
      key = withEvent(`share:${input.mediaId ?? 'post'}`);
      break;
    case 'starter_question':
      key = everyTime ? `starter:${input.eventId}` : `starter:${input.day}`;
      break;
    case 'ref_link':
      key = everyTime ? `ref:${input.eventId}` : `ref:${input.day}`;
      break;
    case 'default_reply':
      key =
        input.defaultReplyMode === 'every_time'
          ? `default:${input.eventId}`
          : `default:${input.day}`;
      break;
    case 'ad_message':
      key = everyTime ? `ad:${input.eventId}` : `ad:${input.adId ?? 'ad'}`;
      break;
    case 'tag_added':
      key = `tag:${input.tag ?? ''}:${input.eventId}`;
      break;
    case 'tag_removed':
      key = `untag:${input.tag ?? ''}:${input.eventId}`;
      break;
  }
  return key.slice(0, AUTOMATION_RUN_ONCE_KEY_MAX_LENGTH);
}
