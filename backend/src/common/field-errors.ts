import { BadRequestException, ConflictException } from '@nestjs/common';

/** Every code a field error can carry. The frontend maps each one to Spanish. */
export type FieldErrorCode =
  | 'name_required'
  | 'cuit_required'
  | 'cuit_invalid'
  | 'cuit_taken'
  | 'payment_term_invalid'
  | 'number_invalid'
  | 'issue_date_invalid'
  | 'due_date_invalid'
  | 'due_date_required'
  | 'due_date_before_issue'
  | 'total_invalid'
  | 'duplicate_number'
  | 'amount_invalid'
  | 'paid_on_invalid'
  | 'value_date_invalid'
  | 'application_amount_invalid'
  | 'exceeds_remaining'
  | 'exceeds_source'
  | 'nothing_to_apply'
  | 'not_applicable'
  | 'remaining_changed'
  | 'document_has_applications'
  | 'photo_type_invalid'
  | 'photo_repeated'
  | 'photo_in_other_document';

export interface FieldError {
  field: string;
  code: FieldErrorCode;
}

/** 400 `{ errors }`. With no errors, it means a malformed request. */
export function invalidRequest(errors: FieldError[] = []): BadRequestException {
  return new BadRequestException({ errors });
}

/** 409 `{ errors }`, for a value that clashes with a stored row. */
export function conflict(errors: FieldError[]): ConflictException {
  return new ConflictException({ errors });
}
