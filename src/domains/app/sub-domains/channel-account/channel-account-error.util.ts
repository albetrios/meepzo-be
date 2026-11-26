import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
  fieldValidationError,
  type AppError,
  type ValidationError,
} from '@/shared/errors/index.js';
import {
  CHANNEL_FEATURES,
  type ChannelFeature,
  type ChannelFeatureRefusalReason,
} from './channel-account-capabilities.constants.js';

/**
 * The channel account's route errors (routes-final § 1B.9) and the one feature check's refusals
 * (CA11, P61) — built here once so every route answers alike.
 */

/** `404 channel_account_not_found` — not this organization's, or revoked (CA6). */
export function channelAccountNotFoundError(): NotFoundError {
  return new NotFoundError('Channel account').withReason('channel_account_not_found');
}

/** `409 channel_account_already_active` — route 11 on an account that is not "not in your plan" (CA9). */
export function channelAccountAlreadyActiveError(): ConflictError {
  return new ConflictError('errors:channelAccountAlreadyActive').withReason(
    'channel_account_already_active',
  );
}

/** `400` on `stop_channel_account_id` — malformed, the same account, not active, or another organization's (CA9). */
export function stopChannelAccountInvalidError(): ValidationError {
  return fieldValidationError({
    field: 'stop_channel_account_id',
    messageKey: 'errors:stopChannelAccountInvalid',
  });
}

/**
 * The one feature check's refusal as a route error, with the statuses of P61 (CAQ2):
 * `422 channel_lacks_feature`, `409 permission_not_granted`, `403 plan_lacks_feature`,
 * `422 feature_not_offered`.
 *
 * @remarks
 * Every refusal carries `error.feature` — the plan feature key the feature reads (its
 * `CHANNEL_FEATURES` plan switch) — and `plan_lacks_feature` also `error.upgrade_required: true`
 * (the plan refusal contract, P269), so a client shows the upgrade without parsing `detail`.
 */
export function channelFeatureRefusalError({
  reason,
  feature,
}: {
  reason: ChannelFeatureRefusalReason;
  feature: ChannelFeature;
}): AppError {
  const fields = { feature: CHANNEL_FEATURES[feature].planSwitch };
  switch (reason) {
    case 'channel_lacks_feature':
      return new UnprocessableEntityError('errors:channelLacksFeature')
        .withReason(reason)
        .withFields(fields);
    case 'permission_not_granted':
      return new ConflictError('errors:permissionNotGranted').withReason(reason).withFields(fields);
    case 'plan_lacks_feature':
      return new ForbiddenError('errors:planLacksFeature')
        .withReason(reason)
        .withFields({ ...fields, upgrade_required: true });
    case 'feature_not_offered':
      return new UnprocessableEntityError('errors:featureNotOffered')
        .withReason(reason)
        .withFields(fields);
  }
}
