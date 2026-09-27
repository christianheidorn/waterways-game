<?php

namespace App\Services\Ai;

use App\Support\AiSettings;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Sleep;
use Illuminate\Support\Str;

/**
 * Thin OpenRouter API client: model discovery, image generation and JSON-returning chat.
 *
 * @see https://openrouter.ai/docs
 */
class OpenRouterClient
{
    public const MODELS_TTL = 3600;

    /** Image parameters we may send; each is only included when the model declares support. */
    private const IMAGE_PARAMS = ['resolution', 'aspect_ratio', 'size', 'quality', 'output_format', 'background', 'n', 'seed'];

    public function __construct(private readonly AiSettings $settings) {}

    public function configured(): bool
    {
        return $this->settings->configured();
    }

    // ---------------------------------------------------------------------------------------
    // Models
    // ---------------------------------------------------------------------------------------

    /**
     * Image generation models, summarised for the studio.
     *
     * @return list<array{id: string, name: string, description: string|null, vision: bool, resolutions: list<string>, supports_references: bool, max_references: int|null, pricing: string|null}>
     */
    public function imageModels(): array
    {
        return array_values(array_map(function (array $m) {
            $params = $this->normalizeSupportedParameters($m['supported_parameters'] ?? []);
            $refs = $params['input_references'] ?? null;

            return [
                'id' => (string) $m['id'],
                'name' => (string) ($m['name'] ?? $m['id']),
                'description' => isset($m['description']) ? Str::limit((string) $m['description'], 300) : null,
                'vision' => in_array('image', $m['architecture']['input_modalities'] ?? [], true),
                'resolutions' => array_values(array_map('strval', $params['resolution']['values'] ?? [])),
                'supports_references' => $refs !== null,
                'max_references' => is_array($refs) && isset($refs['max']) ? (int) $refs['max'] : null,
                'pricing' => $this->pricingSummary($m['pricing'] ?? null),
            ];
        }, array_filter($this->rawImageModels(), fn ($m) => is_array($m) && isset($m['id']))));
    }

    /**
     * Text (chat) models, summarised for the studio. `vision` = accepts image input.
     *
     * @return list<array{id: string, name: string, vision: bool, context_length: int|null, pricing: string|null}>
     */
    public function textModels(): array
    {
        $models = array_filter($this->rawTextModels(), function ($m) {
            $out = $m['architecture']['output_modalities'] ?? ['text'];

            return is_array($m) && isset($m['id']) && in_array('text', $out, true);
        });

        return array_values(array_map(fn (array $m) => [
            'id' => (string) $m['id'],
            'name' => (string) ($m['name'] ?? $m['id']),
            'vision' => in_array('image', $m['architecture']['input_modalities'] ?? [], true),
            'context_length' => isset($m['context_length']) ? (int) $m['context_length'] : null,
            'pricing' => $this->pricingSummary($m['pricing'] ?? null),
        ], $models));
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function rawImageModels(): array
    {
        return Cache::remember('openrouter.models.image', self::MODELS_TTL, fn () => $this->request('get', 'images/models')['data'] ?? []);
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function rawTextModels(): array
    {
        return Cache::remember('openrouter.models.text', self::MODELS_TTL, fn () => $this->request('get', 'models')['data'] ?? []);
    }

    public static function forgetModels(): void
    {
        Cache::forget('openrouter.models.image');
        Cache::forget('openrouter.models.text');
    }

    /**
     * Check the key (GET /key). Returns the key info on success.
     *
     * @return array<string, mixed>
     */
    public function testConnection(): array
    {
        return $this->request('get', 'key')['data'] ?? [];
    }

    /**
     * Remaining account credits in USD (GET /credits), plus this key's own spending limit (GET /key).
     *
     * @return array{remaining: float|null, total: float|null, usage: float|null, key_limit_remaining: float|null}
     */
    public function credits(): array
    {
        $num = fn ($v) => is_numeric($v) ? round((float) $v, 4) : null;

        $total = $usage = null;
        try {
            $data = $this->request('get', 'credits')['data'] ?? [];
            $total = $num($data['total_credits'] ?? null);
            $usage = $num($data['total_usage'] ?? null);
        } catch (OpenRouterException $e) {
            // Some keys may not read account credits; the key's own limit below still helps.
            if ($e->getCode() !== 403 && $e->getCode() !== 401) {
                throw $e;
            }
        }

        $key = $this->request('get', 'key')['data'] ?? [];

        return [
            'remaining' => $total !== null && $usage !== null ? round($total - $usage, 4) : null,
            'total' => $total,
            'usage' => $usage,
            'key_limit_remaining' => $num($key['limit_remaining'] ?? null),
        ];
    }

    // ---------------------------------------------------------------------------------------
    // Image generation
    // ---------------------------------------------------------------------------------------

    /**
     * Generate one image. Only parameters the model declares in `supported_parameters` are sent.
     *
     * @param  array<string, mixed>  $opts  resolution, aspect_ratio, size, quality, output_format, n, seed
     * @param  list<string>  $referenceDataUrls  data: or https: URLs sent as input_references
     * @return array{bytes: string, media_type: string, cost: float|null}
     */
    public function generateImage(string $model, string $prompt, array $opts = [], array $referenceDataUrls = []): array
    {
        $spec = $this->imageModelParameters($model);
        $payload = ['model' => $model, 'prompt' => $prompt];

        foreach (self::IMAGE_PARAMS as $param) {
            if (! array_key_exists($param, $opts) || $opts[$param] === null || $spec === null || ! array_key_exists($param, $spec)) {
                continue;
            }

            $value = $this->fitParameter($spec[$param], $opts[$param]);
            if ($value !== null) {
                $payload[$param] = $value;
            }
        }

        if ($referenceDataUrls !== []) {
            $refSpec = $spec === null ? [] : ($spec['input_references'] ?? false);

            if ($refSpec !== false) {
                $max = is_array($refSpec) && isset($refSpec['max']) ? max(0, (int) $refSpec['max']) : count($referenceDataUrls);
                $payload['input_references'] = array_map(
                    fn (string $url) => ['type' => 'image_url', 'image_url' => ['url' => $url]],
                    array_slice(array_values($referenceDataUrls), 0, $max),
                );
            }
        }

        $body = $this->request('post', 'images', $payload, timeout: 180);
        $first = $body['data'][0] ?? null;

        if (! is_array($first)) {
            throw new OpenRouterException('OpenRouter returned no image for model '.$model.'.');
        }

        $mediaType = (string) ($first['media_type'] ?? 'image/png');

        if (! empty($first['b64_json'])) {
            $bytes = base64_decode((string) $first['b64_json'], true);
        } elseif (! empty($first['url']) && is_string($first['url'])) {
            $bytes = $this->fetchImageUrl($first['url'], $mediaType);
        } else {
            $bytes = false;
        }

        if ($bytes === false || $bytes === '') {
            throw new OpenRouterException('OpenRouter returned an unreadable image for model '.$model.'.');
        }

        $cost = $body['usage']['cost'] ?? null;

        return ['bytes' => $bytes, 'media_type' => $mediaType, 'cost' => is_numeric($cost) ? (float) $cost : null];
    }

    // ---------------------------------------------------------------------------------------
    // Chat
    // ---------------------------------------------------------------------------------------

    /**
     * Chat completion that must answer with a JSON object. The first JSON object in the reply is
     * returned (code fences and surrounding prose are tolerated).
     *
     * @param  string|list<array<string, mixed>>  $userContentParts
     * @return array<string, mixed>
     */
    public function chatJson(string $model, string $system, string|array $userContentParts, int $maxTokens = 2000): array
    {
        $content = is_string($userContentParts) ? [['type' => 'text', 'text' => $userContentParts]] : array_values($userContentParts);

        $payload = [
            'model' => $model,
            'messages' => [
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => $content],
            ],
            'max_tokens' => $maxTokens,
            'temperature' => 0.4,
        ];

        if ($this->textModelSupports($model, 'response_format')) {
            $payload['response_format'] = ['type' => 'json_object'];
        }

        $body = $this->request('post', 'chat/completions', $payload, timeout: 180);
        $message = $body['choices'][0]['message']['content'] ?? null;

        if (is_array($message)) {
            $message = implode("\n", array_map(fn ($part) => is_array($part) ? (string) ($part['text'] ?? '') : (string) $part, $message));
        }

        if (! is_string($message) || trim($message) === '') {
            throw new OpenRouterException('The model '.$model.' returned an empty reply.');
        }

        return self::extractJson($message)
            ?? throw new OpenRouterException('The model '.$model.' did not return valid JSON: '.Str::limit(trim($message), 200));
    }

    /**
     * Find and decode the first JSON object in free text.
     *
     * @return array<string, mixed>|null
     */
    public static function extractJson(string $text): ?array
    {
        $decoded = json_decode(trim($text), true);
        if (is_array($decoded) && ! array_is_list($decoded)) {
            return $decoded;
        }

        $length = strlen($text);
        $offset = 0;

        while (($start = strpos($text, '{', $offset)) !== false) {
            $depth = 0;
            $inString = false;

            for ($i = $start; $i < $length; $i++) {
                $c = $text[$i];

                if ($inString) {
                    if ($c === '\\') {
                        $i++;
                    } elseif ($c === '"') {
                        $inString = false;
                    }

                    continue;
                }

                if ($c === '"') {
                    $inString = true;
                } elseif ($c === '{') {
                    $depth++;
                } elseif ($c === '}') {
                    $depth--;
                    if ($depth === 0) {
                        $candidate = json_decode(substr($text, $start, $i - $start + 1), true);
                        if (is_array($candidate)) {
                            return $candidate;
                        }

                        break;
                    }
                }
            }

            $offset = $start + 1;
        }

        return null;
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    private function http(int $timeout): PendingRequest
    {
        $key = $this->settings->apiKey() ?? throw new AiNotConfiguredException;

        return Http::baseUrl(rtrim((string) config('services.openrouter.url', 'https://openrouter.ai/api/v1'), '/'))
            ->withToken($key)
            ->withHeaders([
                'HTTP-Referer' => (string) config('app.url'),
                'X-Title' => 'Waterways',
            ])
            ->acceptJson()
            ->connectTimeout(15)
            ->timeout($timeout);
    }

    /**
     * Send a request, retrying once on 429 / 5xx / connection errors.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function request(string $method, string $path, array $payload = [], int $timeout = 60): array
    {
        $attempts = 2;

        for ($attempt = 1; ; $attempt++) {
            try {
                /** @var Response $response */
                $response = $method === 'get'
                    ? $this->http($timeout)->get($path, $payload)
                    : $this->http($timeout)->post($path, $payload);
            } catch (ConnectionException $e) {
                if ($attempt < $attempts) {
                    Sleep::sleep(2);

                    continue;
                }

                throw new OpenRouterException('Could not reach OpenRouter: '.$e->getMessage());
            }

            if ($response->successful()) {
                $json = $response->json();

                if (! is_array($json)) {
                    throw new OpenRouterException('OpenRouter returned an invalid response for '.$path.'.');
                }

                // Some errors arrive with HTTP 200 and an "error" body.
                if (isset($json['error']) && ! isset($json['data']) && ! isset($json['choices'])) {
                    throw new OpenRouterException('OpenRouter error: '.$this->errorMessage($response), $response->status());
                }

                return $json;
            }

            $retryable = $response->status() === 429 || $response->serverError();
            if ($retryable && $attempt < $attempts) {
                $retryAfter = (int) $response->header('Retry-After');
                Sleep::sleep($retryAfter > 0 && $retryAfter <= 20 ? $retryAfter : 2);

                continue;
            }

            throw new OpenRouterException(sprintf(
                'OpenRouter request failed (HTTP %d): %s',
                $response->status(),
                $this->errorMessage($response),
            ), $response->status());
        }
    }

    private function errorMessage(Response $response): string
    {
        $error = $response->json('error');

        if (is_array($error)) {
            $message = (string) ($error['message'] ?? json_encode($error));
            $raw = $error['metadata']['raw'] ?? null;
            if (is_string($raw) && $raw !== '') {
                $message .= ' — '.Str::limit($raw, 300);
            }

            return $message;
        }

        if (is_string($error) && $error !== '') {
            return $error;
        }

        return Str::limit(trim($response->body()) ?: $response->reason(), 400);
    }

    /**
     * The model's supported_parameters keyed by name, or null when the model is unknown.
     *
     * @return array<string, mixed>|null
     */
    /**
     * Whether an image model accepts $parameter (with $value, for enum parameters).
     */
    public function imageModelSupports(string $model, string $parameter, ?string $value = null): bool
    {
        $spec = $this->imageModelParameters($model);
        if ($spec === null || ! array_key_exists($parameter, $spec)) {
            return false;
        }

        return $value === null || $this->fitParameter($spec[$parameter], $value) !== null;
    }

    private function imageModelParameters(string $model): ?array
    {
        try {
            $models = $this->rawImageModels();
        } catch (OpenRouterException) {
            return null;
        }

        foreach ($models as $m) {
            if (is_array($m) && ($m['id'] ?? null) === $model) {
                return $this->normalizeSupportedParameters($m['supported_parameters'] ?? []);
            }
        }

        return null;
    }

    private function textModelSupports(string $model, string $parameter): bool
    {
        try {
            $models = $this->rawTextModels();
        } catch (OpenRouterException) {
            return false;
        }

        foreach ($models as $m) {
            if (is_array($m) && ($m['id'] ?? null) === $model) {
                return in_array($parameter, (array) ($m['supported_parameters'] ?? []), true);
            }
        }

        return false;
    }

    /**
     * supported_parameters may be an object keyed by name or a plain list of names.
     *
     * @return array<string, mixed>
     */
    private function normalizeSupportedParameters(mixed $params): array
    {
        if (! is_array($params)) {
            return [];
        }

        if (array_is_list($params)) {
            return array_fill_keys(array_filter($params, 'is_string'), true);
        }

        return $params;
    }

    /**
     * Fit a value to a parameter definition: enum values must match, ranges are clamped.
     */
    private function fitParameter(mixed $definition, mixed $value): mixed
    {
        if (! is_array($definition)) {
            return $value;
        }

        $type = $definition['type'] ?? null;

        if ($type === 'enum' && isset($definition['values']) && is_array($definition['values'])) {
            foreach ($definition['values'] as $allowed) {
                if ((string) $allowed === (string) $value) {
                    return $allowed;
                }
            }

            return null;
        }

        if ($type === 'range' && is_numeric($value)) {
            $value = (int) $value;
            if (isset($definition['min'])) {
                $value = max((int) $definition['min'], $value);
            }
            if (isset($definition['max'])) {
                $value = min((int) $definition['max'], $value);
            }
        }

        return $value;
    }

    private function fetchImageUrl(string $url, string &$mediaType): string|false
    {
        if (str_starts_with($url, 'data:')) {
            if (preg_match('#^data:([^;,]+)?(;base64)?,(.*)$#s', $url, $m) !== 1) {
                return false;
            }
            $mediaType = $m[1] ?: $mediaType;

            return $m[2] !== '' ? base64_decode($m[3], true) : rawurldecode($m[3]);
        }

        $response = Http::timeout(120)->get($url);
        if (! $response->successful()) {
            return false;
        }

        $mediaType = $response->header('Content-Type') ?: $mediaType;

        return $response->body();
    }

    /**
     * Short human-readable price, e.g. "$3.00 / $15.00 per M tokens" or "$0.039 per image".
     */
    private function pricingSummary(mixed $pricing): ?string
    {
        if (! is_array($pricing)) {
            return null;
        }

        $parts = [];
        $prompt = $pricing['prompt'] ?? null;
        $completion = $pricing['completion'] ?? null;

        if (is_numeric($prompt) && is_numeric($completion) && ((float) $prompt > 0 || (float) $completion > 0)) {
            $parts[] = sprintf('$%s / $%s per M tokens', $this->money((float) $prompt * 1_000_000), $this->money((float) $completion * 1_000_000));
        }

        foreach (['image', 'image_output', 'per_image', 'request'] as $key) {
            if (isset($pricing[$key]) && is_numeric($pricing[$key]) && (float) $pricing[$key] > 0) {
                $parts[] = sprintf('$%s per %s', $this->money((float) $pricing[$key]), $key === 'request' ? 'request' : 'image');
                break;
            }
        }

        return $parts === [] ? null : implode(' · ', $parts);
    }

    private function money(float $value): string
    {
        return $value >= 1 ? number_format($value, 2) : rtrim(rtrim(number_format($value, 4), '0'), '.');
    }
}
