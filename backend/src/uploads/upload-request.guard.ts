import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { invalidRequest } from '../common/field-errors.js';

/**
 * Multipart is a content type a cross-site form can send. A form can't set
 * `X-Requested-With`, and a cross-origin `fetch` that sets it needs a CORS
 * preflight, which fails. Route guards run after the global `SessionGuard`
 * and before interceptors, so the multipart parser never sees such a request.
 */
@Injectable()
export class UploadRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers['x-requested-with'] !== 'XMLHttpRequest') {
      throw invalidRequest();
    }
    return true;
  }
}
