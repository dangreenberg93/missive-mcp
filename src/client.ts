/**
 * Missive API client with token validation, error handling, and rate limit detection
 */

import {
  MissiveAPIError,
  AuthError,
  RateLimitError,
  NotFoundError,
} from './errors.js';

const BASE_URL = 'https://public.missiveapp.com/v1';
const REQUEST_TIMEOUT = 30000;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

export class MissiveClient {
  private readonly token: string;

  constructor(token: string) {
    if (!token) {
      throw new Error('API token is required');
    }

    if (token.length < 20) {
      throw new Error('API token appears to be invalid (too short)');
    }

    this.token = token;
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const { method = 'GET', body, params } = options;

    let url = `${BASE_URL}${path}`;

    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          searchParams.set(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      if (response.status === 204) {
        return {} as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof MissiveAPIError) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new MissiveAPIError('Request timeout', 408, 'TIMEOUT');
        }
        // Redact token from any error message
        const safeMessage = error.message.replace(this.token, '[REDACTED]');
        throw new MissiveAPIError(safeMessage, 500, 'UNKNOWN');
      }
      throw new MissiveAPIError('Unknown error occurred', 500, 'UNKNOWN');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    let message = `API error: ${response.status}`;

    try {
      const errorBody = await response.text();
      if (errorBody) {
        // Try to parse as JSON for better error messages
        try {
          const parsed = JSON.parse(errorBody);
          if (parsed.error) {
            // Error could be string or object
            message = typeof parsed.error === 'string'
              ? parsed.error
              : JSON.stringify(parsed.error);
          } else if (parsed.message) {
            message = typeof parsed.message === 'string'
              ? parsed.message
              : JSON.stringify(parsed.message);
          } else {
            // Fallback to stringified response
            message = JSON.stringify(parsed).substring(0, 500);
          }
        } catch {
          // Use text as-is if not JSON
          message = errorBody.substring(0, 200);
        }
      }
    } catch {
      // Ignore errors reading body
    }

    // Redact any token that might be in error messages
    if (typeof message === 'string') {
      message = message.replace(this.token, '[REDACTED]');
    }

    switch (response.status) {
      case 401:
        throw new AuthError(message);
      case 404:
        throw new NotFoundError(message);
      case 429: {
        const retryAfter = response.headers.get('Retry-After');
        throw new RateLimitError(
          message,
          retryAfter ? parseInt(retryAfter, 10) : undefined
        );
      }
      default:
        throw new MissiveAPIError(message, response.status);
    }
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>(path, { method: 'GET', params });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /**
   * Download a Missive signed attachment URL (requires Bearer auth).
   */
  async downloadSignedUrl(url: string, maxBytes: number): Promise<Uint8Array> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new MissiveAPIError(
          `Attachment download failed: ${response.status}`,
          response.status
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) {
          throw new MissiveAPIError(
            `Attachment exceeds max size (${maxBytes} bytes)`,
            413,
            'PAYLOAD_TOO_LARGE'
          );
        }
        return new Uint8Array(buffer);
      }

      const chunks: Uint8Array[] = [];
      let total = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new MissiveAPIError(
            `Attachment exceeds max size (${maxBytes} bytes)`,
            413,
            'PAYLOAD_TOO_LARGE'
          );
        }
        chunks.push(value);
      }

      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return merged;
    } catch (error) {
      if (error instanceof MissiveAPIError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new MissiveAPIError('Attachment download timeout', 408, 'TIMEOUT');
      }
      const safeMessage =
        error instanceof Error
          ? error.message.replace(this.token, '[REDACTED]')
          : 'Unknown attachment download error';
      throw new MissiveAPIError(safeMessage, 500, 'UNKNOWN');
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Per-token client cache using WeakRef for GC-friendly caching
const clientCache = new Map<string, WeakRef<MissiveClient>>();
const registry = new FinalizationRegistry<string>((token) => {
  clientCache.delete(token);
});

export function getClientForToken(token: string): MissiveClient {
  const ref = clientCache.get(token);
  const existing = ref?.deref();
  if (existing) return existing;

  const client = new MissiveClient(token);
  clientCache.set(token, new WeakRef(client));
  registry.register(client, token);
  return client;
}

// Singleton for stdio mode (backward compat)
let stdioClient: MissiveClient | null = null;

export function getClient(): MissiveClient {
  if (!stdioClient) {
    const token = process.env.MISSIVE_API_TOKEN;
    if (!token) {
      throw new Error('MISSIVE_API_TOKEN environment variable is required');
    }
    stdioClient = new MissiveClient(token);
  }
  return stdioClient;
}
