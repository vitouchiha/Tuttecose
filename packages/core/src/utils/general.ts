import { createLogger } from './logger.js';
import path from 'path';
import { Addon, Preset } from '../db/schemas.js';
import { parseConnectionURI } from '../db/utils.js';
import { Env } from './env.js';
const logger = createLogger('utils-general');

export function getDataFolder(): string {
  const databaseURI = parseConnectionURI(Env.DATABASE_URI);
  if (databaseURI.dialect === 'sqlite') {
    return path.dirname(databaseURI.filename);
  }
  return path.join(process.cwd(), 'data');
}

export function getAddonName(addon: Addon | Preset): string {
  return 'type' in addon
    ? addon.type
    : `${addon.name}${addon.displayIdentifier || addon.identifier ? ` ${addon.displayIdentifier || addon.identifier}` : ''}`;
}

export interface RetryOptions {
  /**
   * Number of retry attempts (not including initial attempt)
   * @default 1
   */
  retries?: number;
  /**
   * Optional function to determine if an error should trigger a retry
   * @param error The error that was thrown
   * @returns true if should retry, false otherwise
   */
  shouldRetry?: (error: any) => boolean;
  /**
   * Optional function to get context for error logging
   * @returns string context to include in error logs
   */
  getContext?: () => string;
}

/**
 * Utility function to retry an async operation
 * @param operation The async operation to retry
 * @param options Retry configuration options
 * @returns The result of the operation
 * @throws The last error encountered if all retries fail
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { retries = 1, shouldRetry, getContext } = options;
  const maxAttempts = retries + 1; // +1 for initial attempt

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts - 1;
      const shouldTryAgain =
        !isLastAttempt && (!shouldRetry || shouldRetry(error));
      const context = getContext ? ` for ${getContext()}` : '';

      if (shouldTryAgain) {
        logger.warn(
          `Operation failed${context}: ${error}. Will retry ${maxAttempts - attempt - 1} more time(s).`
        );
      } else {
        if (isLastAttempt) {
          logger.warn(
            `Operation failed${context}: ${error}. All retries exhausted.`
          );
        } else {
          logger.warn(
            `Operation failed${context}: ${error}. Not retrying due to error type.`
          );
        }
        throw error;
      }
    }
  }

  // This line should never be reached due to the throw in the catch block
  throw new Error('Unexpected state in retry logic');
}

/**
 * Base64 URL safe encoding
 * @param data - The data to encode
 * @returns The base64 URL safe encoded data
 */
export function toUrlSafeBase64(string: string): string {
  return Buffer.from(string)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64 URL safe decoding
 * @param data - The data to decode
 * @returns The base64 URL safe decoded data
 */
export function fromUrlSafeBase64(data: string): string {
  // Add padding if needed
  const padding = data.length % 4;
  const paddedData = padding ? data + '='.repeat(4 - padding) : data;

  return Buffer.from(
    paddedData.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf-8');
}
