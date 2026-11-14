import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Lets a route answer without a session. Only sign-in uses it: making any
 * other route public is a one-way door.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
