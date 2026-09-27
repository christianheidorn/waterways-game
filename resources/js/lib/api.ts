/** Error thrown by {@link apiFetch} with the server's message (and validation errors when present). */
export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly errors: Record<string, string[]> = {},
        /** The decoded JSON error body (e.g. `{ message, configured: false }`). */
        public readonly data: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

function xsrfToken(): string | null {
    const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);

    return match ? decodeURIComponent(match[1]) : null;
}

type Options = {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
};

/**
 * JSON request to the studio's API (same origin, cookies included).
 * Throws an {@link ApiError} with a readable message on non-2xx responses.
 */
export async function apiFetch<T>(
    url: string,
    { method = 'GET', body, signal }: Options = {},
): Promise<T> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };
    const token = xsrfToken();

    if (token) {
        headers['X-XSRF-TOKEN'] = token;
    }

    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
    });

    const text = await response.text();
    let data: unknown = null;

    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }

    if (!response.ok) {
        const payload = (data ?? {}) as {
            message?: string;
            errors?: Record<string, string[]>;
        };
        const firstError = payload.errors
            ? Object.values(payload.errors)[0]?.[0]
            : undefined;

        throw new ApiError(
            firstError ??
                payload.message ??
                `Request failed (${response.status} ${response.statusText})`,
            response.status,
            payload.errors ?? {},
            (data ?? {}) as Record<string, unknown>,
        );
    }

    return data as T;
}

/** True when the server says no OpenRouter key is configured. */
export function isAiNotConfigured(error: unknown): boolean {
    return (
        error instanceof ApiError &&
        (error.data.configured === false ||
            /not configured/i.test(error.message))
    );
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return 'Something went wrong.';
}
