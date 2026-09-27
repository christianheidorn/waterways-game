<?php

namespace App\Services\Ai;

use App\Support\AiSettings;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Sleep;

/**
 * Meshy (https://www.meshy.ai) text / image to 3D API.
 *
 * Tasks are asynchronous: create → poll GET /{endpoint}/{id} until SUCCEEDED / FAILED → download
 * model_urls.glb. Text to 3D lives under /openapi/v2, everything else under /openapi/v1.
 */
class MeshyClient
{
    public const ENDPOINTS = [
        'text-to-3d' => '/openapi/v2/text-to-3d',
        'image-to-3d' => '/openapi/v1/image-to-3d',
        'rigging' => '/openapi/v1/rigging',
        'animations' => '/openapi/v1/animations',
    ];

    public function __construct(private readonly AiSettings $settings) {}

    public function configured(): bool
    {
        return $this->settings->meshyConfigured();
    }

    /**
     * Remaining Meshy credits (free call; cached briefly).
     */
    public function balance(bool $fresh = false): int
    {
        if ($fresh) {
            self::forgetBalance();
        }

        return (int) Cache::remember('meshy.balance', 20, fn () => (int) ($this->request('get', '/openapi/v1/balance')['balance'] ?? 0));
    }

    public static function forgetBalance(): void
    {
        Cache::forget('meshy.balance');
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    public function create(string $type, array $payload): string
    {
        $json = $this->request('post', self::ENDPOINTS[$type], $payload);
        $id = $json['result'] ?? null;

        if (! is_string($id) || $id === '') {
            throw new MeshyException('Meshy did not return a task id.');
        }

        self::forgetBalance();

        return $id;
    }

    /**
     * @return array<string, mixed>
     */
    public function task(string $type, string $id): array
    {
        return $this->request('get', self::ENDPOINTS[$type].'/'.rawurlencode($id));
    }

    public function download(string $url, string $target): void
    {
        if (! preg_match('#^https://#', $url)) {
            throw new MeshyException('Meshy returned an invalid download URL.');
        }

        $response = Http::timeout(300)->sink($target)->get($url);
        if (! $response->successful()) {
            throw new MeshyException("Downloading the Meshy model failed (HTTP {$response->status()}).");
        }
    }

    private function http(int $timeout): PendingRequest
    {
        $key = $this->settings->meshyKey();
        if ($key === null) {
            throw new MeshyException('Meshy is not configured: add a Meshy API key under Settings → AI.');
        }

        return Http::baseUrl(rtrim((string) config('services.meshy.url', 'https://api.meshy.ai'), '/'))
            ->withToken($key)
            ->acceptJson()
            ->connectTimeout(15)
            ->timeout($timeout);
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function request(string $method, string $path, array $payload = [], int $timeout = 60): array
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                /** @var Response $response */
                $response = $method === 'get'
                    ? $this->http($timeout)->get($path, $payload)
                    : $this->http($timeout)->post($path, $payload);
            } catch (ConnectionException $e) {
                if ($attempt < 2) {
                    Sleep::sleep(2);

                    continue;
                }

                throw new MeshyException('Could not reach Meshy: '.$e->getMessage());
            }

            if ($response->successful()) {
                $json = $response->json();
                if (! is_array($json)) {
                    throw new MeshyException('Meshy returned an invalid response.');
                }

                return $json;
            }

            if (($response->status() === 429 || $response->serverError()) && $attempt < 2) {
                Sleep::sleep(3);

                continue;
            }

            $message = $response->json('message') ?? $response->json('error') ?? $response->body();
            $hint = match ($response->status()) {
                401 => ' Check the Meshy API key.',
                402 => ' Not enough Meshy credits.',
                default => '',
            };

            throw new MeshyException(sprintf('Meshy request failed (HTTP %d): %s%s', $response->status(), is_string($message) ? mb_substr($message, 0, 300) : json_encode($message), $hint), $response->status());
        }
    }
}
