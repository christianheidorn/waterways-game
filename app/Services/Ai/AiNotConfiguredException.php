<?php

namespace App\Services\Ai;

use RuntimeException;

/**
 * No OpenRouter API key is stored in the studio or set in OPENROUTER_API_KEY.
 */
class AiNotConfiguredException extends RuntimeException
{
    public function __construct(string $message = 'AI is not configured: add an OpenRouter API key under Settings → AI.')
    {
        parent::__construct($message);
    }
}
