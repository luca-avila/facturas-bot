import type { ApiResult, FieldError, FieldErrorCode } from '../accounts-api'
import { FIELD_ERROR_MESSAGES, REJECTED_WITHOUT_FIELDS_MESSAGE, UNAVAILABLE_MESSAGE } from '../labels'

export type FieldMessages = Partial<Record<string, string>>

/** The Spanish message for each field that has an error. The first error of a field wins. */
export function messagesByField(errors: FieldError[]): FieldMessages {
  const messages: FieldMessages = {}
  for (const { field, code } of errors) messages[field] ??= FIELD_ERROR_MESSAGES[code]
  return messages
}

export function localError(field: string, code: FieldErrorCode): FieldMessages {
  return { [field]: FIELD_ERROR_MESSAGES[code] }
}

/**
 * What a failed save shows: field messages, or one message for the form.
 * `unauthorized` shows nothing, since the app goes back to sign-in.
 */
export function failedSave(
  result: Exclude<ApiResult<unknown>, { ok: true }>,
): { fields: FieldMessages; form: string | null } {
  switch (result.error) {
    case 'rejected':
      return result.fieldErrors.length > 0
        ? { fields: messagesByField(result.fieldErrors), form: null }
        : { fields: {}, form: REJECTED_WITHOUT_FIELDS_MESSAGE }
    case 'not_found':
      return { fields: {}, form: REJECTED_WITHOUT_FIELDS_MESSAGE }
    case 'unavailable':
      return { fields: {}, form: UNAVAILABLE_MESSAGE }
    case 'unauthorized':
      return { fields: {}, form: null }
  }
}
