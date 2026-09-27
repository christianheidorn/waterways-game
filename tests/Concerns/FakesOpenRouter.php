<?php

namespace Tests\Concerns;

use App\Support\AiSettings;
use Illuminate\Support\Facades\Http;

trait FakesOpenRouter
{
    protected function configureAi(string $key = 'sk-or-v1-0123456789secretabcd'): void
    {
        app(AiSettings::class)->update(['openrouter_api_key' => $key]);
    }

    /**
     * @return array<string, mixed>
     */
    protected function imageModelsResponse(): array
    {
        return ['data' => [
            [
                'id' => 'google/gemini-3.1-flash-image',
                'name' => 'Gemini 3.1 Flash Image',
                'architecture' => ['input_modalities' => ['text', 'image'], 'output_modalities' => ['image', 'text']],
                'supported_parameters' => [
                    'resolution' => ['type' => 'enum', 'values' => ['512', '1K', '2K', '4K']],
                    'aspect_ratio' => ['type' => 'enum', 'values' => ['1:1', '16:9']],
                    'input_references' => ['type' => 'range', 'min' => 0, 'max' => 3],
                ],
                'pricing' => ['image' => '0.039'],
            ],
            [
                'id' => 'acme/basic-image',
                'name' => 'Basic',
                'architecture' => ['input_modalities' => ['text'], 'output_modalities' => ['image']],
                'supported_parameters' => ['seed' => ['type' => 'boolean'], 'n' => ['type' => 'range', 'min' => 1, 'max' => 2]],
            ],
        ]];
    }

    /**
     * @return array<string, mixed>
     */
    protected function textModelsResponse(): array
    {
        return ['data' => [
            [
                'id' => 'anthropic/claude-sonnet-5', 'name' => 'Claude Sonnet 5', 'context_length' => 200000,
                'architecture' => ['input_modalities' => ['text', 'image'], 'output_modalities' => ['text']],
                'pricing' => ['prompt' => '0.000003', 'completion' => '0.000015'],
                'supported_parameters' => ['max_tokens', 'temperature'],
            ],
            [
                'id' => 'openai/gpt-json', 'name' => 'JSON model',
                'architecture' => ['input_modalities' => ['text'], 'output_modalities' => ['text']],
                'supported_parameters' => ['response_format'],
            ],
        ]];
    }

    /**
     * @return array<string, mixed>
     */
    protected function imageResponse(string $png): array
    {
        return ['created' => 1, 'data' => [['b64_json' => base64_encode($png), 'media_type' => 'image/png']], 'usage' => ['cost' => 0.039]];
    }

    /**
     * @param  array<string, mixed>|string  $content  JSON-able payload or raw assistant text
     * @return array<string, mixed>
     */
    protected function chatResponse(array|string $content): array
    {
        return ['choices' => [['message' => ['role' => 'assistant', 'content' => is_string($content) ? $content : json_encode($content)]]]];
    }

    /**
     * @param  array<string, mixed>  $extra  url patterns → responses (override the defaults)
     */
    protected function fakeOpenRouter(?string $png = null, array|string|null $chat = null, array $extra = []): void
    {
        Http::fake([
            'openrouter.ai/api/v1/images/models' => Http::response($this->imageModelsResponse()),
            'openrouter.ai/api/v1/images' => Http::response($this->imageResponse($png ?? '')),
            'openrouter.ai/api/v1/models' => Http::response($this->textModelsResponse()),
            'openrouter.ai/api/v1/chat/completions' => Http::response($this->chatResponse($chat ?? ['prompt' => 'enhanced'])),
            'openrouter.ai/api/v1/key' => Http::response(['data' => ['label' => 'studio', 'limit_remaining' => 12.5]]),
            ...$extra,
        ]);
    }
}
