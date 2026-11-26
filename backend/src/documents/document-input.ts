import { bodyWithKeys, isStringOrNull, optionalText } from '../common/body.js';
import { isIsoDate } from '../common/dates.js';
import { type FieldError, invalidRequest } from '../common/field-errors.js';
import { Money } from '../common/money.js';
import { isUuid } from '../common/uuid.js';
import {
  DocumentType,
  type DueDateSource,
} from '../generated/prisma/client.js';
import { normalizeNumber } from './document-number.js';

/** A manually entered document, checked and trimmed. */
export interface ManualDocumentFields {
  supplierId: string;
  type: DocumentType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  total: Money;
  notes: string | null;
}

/** An edited document header (`PUT /api/documents/:id`), checked and trimmed. */
export interface UpdateDocumentFields {
  supplierId: string;
  type: DocumentType;
  letter: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  dueDateSource: DueDateSource | null;
  subtotal: Money | null;
  total: Money;
  notes: string | null;
}

const KEYS = [
  'supplierId',
  'type',
  'letter',
  'number',
  'issueDate',
  'dueDate',
  'total',
  'notes',
] as const;

const UPDATE_KEYS = [
  'supplierId',
  'type',
  'letter',
  'number',
  'issueDate',
  'dueDate',
  'dueDateSource',
  'subtotal',
  'total',
  'notes',
] as const;

const LETTERS: readonly string[] = ['A', 'B', 'C', 'M', 'X'];

function isDocumentType(value: unknown): value is DocumentType {
  return Object.values<unknown>(DocumentType).includes(value);
}

function isDueDateSource(value: unknown): value is DueDateSource {
  return value === 'supplier_term' || value === 'manual';
}

/**
 * An invoice or delivery note can't fall due before it was issued, so a typed
 * date like that is a typo, such as 2025 for 2026, that would make it overdue
 * at once. An opening balance can: its overdue part is often typed with the
 * cutover date as its issue date and a past due date.
 */
function dueBeforeIssueMatters(type: DocumentType): boolean {
  return type === 'invoice' || type === 'delivery_note';
}

function readTotal(total: string): Money | null {
  try {
    const money = Money.fromString(total);
    return money.isPositive() ? money : null;
  } catch {
    return null;
  }
}

function readSubtotal(subtotal: string): Money | null {
  try {
    const money = Money.fromString(subtotal);
    return money.isPositive() || money.isZero() ? money : null;
  } catch {
    return null;
  }
}

/**
 * Reads a `DocumentInput` body. A missing key, a wrong JSON type, or a field
 * the type never has (a letter or number on an opening balance, a due date on
 * a credit note) is a malformed request. User mistakes come back together as
 * field errors. Whether the supplier exists and needs a due date is checked
 * in the transaction.
 */
export function parseDocumentInput(body: unknown): ManualDocumentFields {
  const raw = bodyWithKeys(body, KEYS);
  const { supplierId, type, letter, issueDate, dueDate, total, notes } = raw;
  if (
    typeof supplierId !== 'string' ||
    !isUuid(supplierId) ||
    !isDocumentType(type) ||
    !(
      letter === null ||
      (typeof letter === 'string' && LETTERS.includes(letter))
    ) ||
    !isStringOrNull(raw.number) ||
    typeof issueDate !== 'string' ||
    !isStringOrNull(dueDate) ||
    typeof total !== 'string' ||
    !isStringOrNull(notes)
  ) {
    throw invalidRequest();
  }
  const number = optionalText(raw.number);
  if (type === 'opening_balance' && (letter !== null || number !== null)) {
    throw invalidRequest();
  }
  if (type === 'credit_note' && dueDate !== null) throw invalidRequest();

  const errors: FieldError[] = [];
  if (number !== null && normalizeNumber(number) === null) {
    errors.push({ field: 'number', code: 'number_invalid' });
  }
  if (!isIsoDate(issueDate)) {
    errors.push({ field: 'issueDate', code: 'issue_date_invalid' });
  }
  if (dueDate !== null && !isIsoDate(dueDate)) {
    errors.push({ field: 'dueDate', code: 'due_date_invalid' });
  } else if (
    dueDate !== null &&
    isIsoDate(issueDate) &&
    dueBeforeIssueMatters(type) &&
    dueDate < issueDate
  ) {
    errors.push({ field: 'dueDate', code: 'due_date_before_issue' });
  }
  const money = readTotal(total);
  if (money === null) errors.push({ field: 'total', code: 'total_invalid' });

  if (errors.length > 0 || money === null) throw invalidRequest(errors);
  return {
    supplierId,
    type,
    letter,
    number,
    issueDate,
    dueDate,
    total: money,
    notes: optionalText(notes),
  };
}

/**
 * Reads an `UpdateDocumentInput` body (`PUT /api/documents/:id`). Structural
 * impossibilities for the chosen `type` are malformed; user mistakes come back
 * together as field errors.
 */
export function parseUpdateDocumentInput(body: unknown): UpdateDocumentFields {
  const raw = bodyWithKeys(body, UPDATE_KEYS);
  const {
    supplierId: rawSupplierId,
    type,
    letter,
    issueDate,
    dueDate,
    dueDateSource,
    subtotal: rawSubtotal,
    total,
    notes,
  } = raw;
  if (
    !isStringOrNull(rawSupplierId) ||
    !isDocumentType(type) ||
    !(
      letter === null ||
      (typeof letter === 'string' && LETTERS.includes(letter))
    ) ||
    !isStringOrNull(raw.number) ||
    typeof issueDate !== 'string' ||
    !isStringOrNull(dueDate) ||
    !(dueDateSource === null || isDueDateSource(dueDateSource)) ||
    !isStringOrNull(rawSubtotal) ||
    typeof total !== 'string' ||
    !isStringOrNull(notes)
  ) {
    throw invalidRequest();
  }

  const trimmedSupplierId =
    rawSupplierId === null ? '' : rawSupplierId.trim();
  if (trimmedSupplierId !== '' && !isUuid(trimmedSupplierId)) {
    throw invalidRequest();
  }

  const number = optionalText(raw.number);
  const trimmedSubtotal = optionalText(rawSubtotal);

  if (type === 'opening_balance') {
    if (letter !== null || number !== null || trimmedSubtotal !== null) {
      throw invalidRequest();
    }
    if (dueDateSource === 'supplier_term') throw invalidRequest();
    if (dueDate === null && dueDateSource !== null) throw invalidRequest();
    if (dueDate !== null && dueDateSource !== 'manual') throw invalidRequest();
  } else if (type === 'credit_note') {
    if (dueDate !== null || dueDateSource !== null) throw invalidRequest();
  } else {
    if (dueDateSource === 'supplier_term' && dueDate !== null) {
      throw invalidRequest();
    }
    if (dueDateSource === null && dueDate !== null) throw invalidRequest();
  }

  const errors: FieldError[] = [];
  if (trimmedSupplierId === '') {
    errors.push({ field: 'supplierId', code: 'supplier_required' });
  }
  if (number !== null && normalizeNumber(number) === null) {
    errors.push({ field: 'number', code: 'number_invalid' });
  }
  if (!isIsoDate(issueDate)) {
    errors.push({ field: 'issueDate', code: 'issue_date_invalid' });
  }
  if (type === 'opening_balance') {
    if (dueDate !== null && !isIsoDate(dueDate)) {
      errors.push({ field: 'dueDate', code: 'due_date_invalid' });
    }
  } else if (dueBeforeIssueMatters(type)) {
    if (dueDateSource === 'manual') {
      if (dueDate === null || dueDate.trim() === '') {
        errors.push({ field: 'dueDate', code: 'due_date_required' });
      } else if (!isIsoDate(dueDate)) {
        errors.push({ field: 'dueDate', code: 'due_date_invalid' });
      } else if (isIsoDate(issueDate) && dueDate < issueDate) {
        errors.push({ field: 'dueDate', code: 'due_date_before_issue' });
      }
    } else if (dueDateSource === null) {
      errors.push({ field: 'dueDate', code: 'due_date_required' });
    }
  }

  let parsedSubtotal: Money | null = null;
  if (trimmedSubtotal !== null) {
    parsedSubtotal = readSubtotal(trimmedSubtotal);
    if (parsedSubtotal === null) {
      errors.push({ field: 'subtotal', code: 'subtotal_invalid' });
    }
  }

  const parsedTotal = readTotal(total);
  if (parsedTotal === null) {
    errors.push({ field: 'total', code: 'total_invalid' });
  }

  if (errors.length > 0 || parsedTotal === null) throw invalidRequest(errors);
  return {
    supplierId: trimmedSupplierId,
    type,
    letter,
    number,
    issueDate,
    dueDate,
    dueDateSource,
    subtotal: parsedSubtotal,
    total: parsedTotal,
    notes: optionalText(notes),
  };
}
