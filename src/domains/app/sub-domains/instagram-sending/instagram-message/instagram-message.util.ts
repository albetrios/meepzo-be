import type {
  ChannelMessageResult,
  ChannelMessageStep,
  SaveWaitingMessageInput,
} from '@/domains/app/app.channel-ports.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  INSTAGRAM_DIRECT_MESSAGE_TYPES,
  INSTAGRAM_MESSAGE_TYPE_OF_STEP,
  type InstagramMessageChannel,
  type InstagramMessageFinalStatus,
  type InstagramMessageType,
} from './instagram-message.constants.js';

/** Where a waiting message goes (SN22): its type, lane, delivery channel and whether it counts. */
export interface InstagramMessagePlace {
  kind: 'place';
  messageType: InstagramMessageType;
  lane: InstagramSendLane;
  channel: InstagramMessageChannel | null;
  isCountedAsDirectMessage: boolean;
}

/** A message that can never go (AU35's `skipped` answer): her window is closed for a DM. */
export interface InstagramMessageNoPlace {
  kind: 'skip';
  reason: 'window_closed';
}

/** Whether her 24-hour window is open at `now` (D8): her last DM, story reply or tap + 24 h − 15 min. */
export function isInstagramChatWindowOpen({
  lastDirectMessageReceivedAt,
  now,
  windowMilliseconds,
}: {
  lastDirectMessageReceivedAt: Date | null;
  now: Date;
  windowMilliseconds: number;
}): boolean {
  return (
    lastDirectMessageReceivedAt !== null &&
    lastDirectMessageReceivedAt.getTime() + windowMilliseconds > now.getTime()
  );
}

/**
 * The lane rule (SN22, plan §19.1 checks 1–3): a public reply or hide waits in the reply lane; a
 * follow check (a read) in the fast lane without a channel; a broadcast in its lane; a comment's
 * first DM (it answers the comment) is a private reply — in the fast lane for a Live comment (D40),
 * a plain DM in the fast lane when her window is already open, else in the slow lane; every other
 * DM goes fast and direct while her window is open, and can never go once it is closed.
 *
 * @remarks
 * Pure — the service reads her window and the run's way to start; the type follows the step
 * ({@link INSTAGRAM_MESSAGE_TYPE_OF_STEP}), `is_counted_as_direct_message` the type (D34).
 */
export function chooseInstagramMessagePlace({
  step,
  triggerType,
  answersEventId,
  isWindowOpen,
}: {
  step: ChannelMessageStep;
  triggerType: string | null;
  answersEventId: SaveWaitingMessageInput['answersEventId'];
  isWindowOpen: boolean;
}): InstagramMessagePlace | InstagramMessageNoPlace {
  const messageType = INSTAGRAM_MESSAGE_TYPE_OF_STEP[step];
  const isCountedAsDirectMessage = INSTAGRAM_DIRECT_MESSAGE_TYPES.includes(messageType);
  const place = ({
    lane,
    channel,
  }: {
    lane: InstagramSendLane;
    channel: InstagramMessageChannel | null;
  }): InstagramMessagePlace => ({
    kind: 'place',
    messageType,
    lane,
    channel,
    isCountedAsDirectMessage,
  });
  switch (step) {
    case 'public_reply':
      return place({ lane: 'reply', channel: 'comment_reply' });
    case 'hide_comment':
      return place({ lane: 'reply', channel: 'comment_hide' });
    case 'follow_check':
      return place({ lane: 'fast', channel: null });
    case 'broadcast':
      return place({ lane: 'broadcast', channel: 'direct' });
    default:
      break;
  }
  if (answersEventId !== null) {
    if (triggerType === 'live_comment') return place({ lane: 'fast', channel: 'private_reply' });
    return isWindowOpen
      ? place({ lane: 'fast', channel: 'direct' })
      : place({ lane: 'slow', channel: 'private_reply' });
  }
  return isWindowOpen
    ? place({ lane: 'fast', channel: 'direct' })
    : { kind: 'skip', reason: 'window_closed' };
}

/** The step a message type was saved for — the result goes back to the engine by step (AU35). */
export function instagramMessageStepOf(messageType: InstagramMessageType): ChannelMessageStep {
  if (messageType === 'invalid_email') return 'email';
  const entry = Object.entries(INSTAGRAM_MESSAGE_TYPE_OF_STEP).find(
    ([, type]) => type === messageType,
  );
  return entry![0] as ChannelMessageStep;
}

/** A final status as the engine's result (AU35): `expired` arrives as `skipped` with its reason. */
export function channelResultOf(status: InstagramMessageFinalStatus): ChannelMessageResult {
  return status === 'expired' ? 'skipped' : status;
}
