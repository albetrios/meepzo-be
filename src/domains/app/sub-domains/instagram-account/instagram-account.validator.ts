import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  ConnectInstagramAccountDto,
  type ConnectInstagramAccountInput,
} from './instagram-account.dto.js';

/**
 * Parses the `POST /app/social/instagram/connect` body with the strict
 * {@link ConnectInstagramAccountDto}; throws `ValidationError` (400, `errors[].field = 'code'`, or
 * the unknown field's name) on a missing, empty or over-long code or an unknown field.
 */
export function validateConnectInstagramAccount(data: unknown): ConnectInstagramAccountInput {
  return parseWithSchema({ schema: ConnectInstagramAccountDto, data });
}
