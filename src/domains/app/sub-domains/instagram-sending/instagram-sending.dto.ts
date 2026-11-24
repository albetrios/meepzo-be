import { channelAccountIdParamsDto } from '@/domains/app/sub-domains/channel-account/channel-account.dto.js';

/**
 * Path of `GET /app/social/instagram/accounts/{channel_account_id}/sending-status` (route 63,
 * routes-final § 6.A): the channel account's `cha_` id.
 *
 * @remarks
 * The channel account's own params schema (`channelAccountIdParamsDto`), reused so route 63 checks
 * the id exactly as routes 6–12 do; route 64 (`GET /app/usage`) takes no path, query or body.
 */
export const instagramSendingStatusParamsDto = channelAccountIdParamsDto;
