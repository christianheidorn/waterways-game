<?php

namespace App\Services\Ai;

use RuntimeException;

/**
 * OpenRouter answered with an error, or with something we could not use.
 */
class OpenRouterException extends RuntimeException
{
    public function __construct(string $message, public readonly ?int $status = null)
    {
        parent::__construct($message);
    }
}
