<?php

namespace App\Http\Controllers;

use App\Services\Ai\AiNotConfiguredException;
use App\Services\Ai\OpenRouterClient;
use App\Services\Ai\OpenRouterException;
use App\Support\AiSettings;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Studio → Settings → AI: the OpenRouter key (write-only) and model choices.
 */
class AiSettingsController extends Controller
{
    public function edit(AiSettings $settings): Response
    {
        return Inertia::render('settings/ai', [
            'settings' => $settings->toFrontend(),
        ]);
    }

    public function update(Request $request, AiSettings $settings): RedirectResponse
    {
        $data = $request->validate([
            'openrouter_api_key' => ['nullable', 'string', 'max:500'],
            'clear_key' => ['sometimes', 'boolean'],
            'image_model' => ['sometimes', 'nullable', 'string', 'max:200', 'regex:'.AiSettings::MODEL_PATTERN],
            'text_model' => ['sometimes', 'nullable', 'string', 'max:200', 'regex:'.AiSettings::MODEL_PATTERN],
            'image_resolution' => ['sometimes', 'nullable', Rule::in(AiSettings::RESOLUTIONS)],
        ]);

        $keyChanged = ! empty($data['clear_key']) || trim((string) ($data['openrouter_api_key'] ?? '')) !== '';
        $settings->update([...$data, 'clear_key' => $request->boolean('clear_key')]);

        if ($keyChanged) {
            OpenRouterClient::forgetModels();
        }

        $this->toast('success', 'AI settings saved.');

        return back();
    }

    public function test(OpenRouterClient $client): RedirectResponse
    {
        try {
            $info = $client->testConnection();
        } catch (AiNotConfiguredException $e) {
            $this->toast('error', $e->getMessage());

            return back();
        } catch (OpenRouterException $e) {
            $this->toast('error', 'Connection failed: '.$e->getMessage());

            return back();
        }

        $label = is_string($info['label'] ?? null) && $info['label'] !== '' ? ' ('.$info['label'].')' : '';
        $limit = isset($info['limit_remaining']) && is_numeric($info['limit_remaining'])
            ? sprintf(' — $%.2f credit remaining', (float) $info['limit_remaining'])
            : '';

        $this->toast('success', 'Connected to OpenRouter'.$label.$limit.'.');

        return back();
    }
}
