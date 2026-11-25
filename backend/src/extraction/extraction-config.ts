import { Injectable } from '@nestjs/common';
import { isValidCuit } from '../common/cuit.js';

/**
 * The worker's settings, read from `process.env` when the worker starts. A
 * missing or bad one stops it, naming the variable and never its value. Only
 * the worker reads them.
 */
@Injectable()
export class ExtractionConfig {
  readonly apiKey: string;
  readonly model: string;
  /** 11 digits. It never resolves a supplier. */
  readonly restaurantCuit: string;

  constructor() {
    this.apiKey = required('ANTHROPIC_API_KEY');
    this.model = required('LLM_MODEL');
    const cuit = process.env.RESTAURANT_CUIT ?? '';
    if (!isValidCuit(cuit)) {
      throw new Error(
        "RESTAURANT_CUIT must be the restaurant's CUIT, 11 digits with no hyphens and a valid check digit. Put it in .env.",
      );
    }
    this.restaurantCuit = cuit;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (value === '') throw new Error(`${name} must be set. Put it in .env.`);
  return value;
}
