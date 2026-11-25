import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import {
  createOrganizationDto,
  updateOrganizationDto,
  listOrganizationChooserQueryDto,
  uploadLogoDto,
} from './organization.dto.js';
import type {
  CreateOrganizationInput,
  UpdateOrganizationInput,
  ListOrganizationChooserQueryInput,
  UploadLogoInput,
} from './organization.dto.js';

/** Parses raw `POST /organizations` body via {@link createOrganizationDto}; throws `ValidationError('errors:invalidInput')` on failure. */
export function validateCreateOrganization(data: unknown): CreateOrganizationInput {
  return parseWithSchema({ schema: createOrganizationDto, data });
}

/** Parses raw `PATCH /organization` body via {@link updateOrganizationDto}; throws `ValidationError('errors:invalidInput')` on failure. */
export function validateUpdateOrganization(data: unknown): UpdateOrganizationInput {
  return parseWithSchema({ schema: updateOrganizationDto, data });
}

/**
 * Validates the organization chooser's query (`GET /users/me/organizations`) against the strict
 * {@link listOrganizationChooserQueryDto} (cursor pagination and `q`). Throws
 * `ValidationError('errors:validation.invalidPagination')` on failure.
 */
export function validateListOrganizationChooserQuery(
  data: unknown,
): ListOrganizationChooserQueryInput {
  return parseWithSchema({
    schema: listOrganizationChooserQueryDto,
    data,
    errorKey: 'errors:validation.invalidPagination',
  });
}

/** Parses raw `PUT /organization/logo` body via {@link uploadLogoDto}; throws `ValidationError('errors:invalidInput')` on failure. */
export function validateUploadLogo(data: unknown): UploadLogoInput {
  return parseWithSchema({ schema: uploadLogoDto, data });
}
