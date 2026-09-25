<?php

namespace App\Http\Controllers;

use Inertia\Inertia;

abstract class Controller
{
    /**
     * Flash a toast notification to the studio UI (rendered by useFlashToast).
     *
     * @param  'success'|'info'|'warning'|'error'  $type
     */
    protected function toast(string $type, string $message): void
    {
        Inertia::flash('toast', ['type' => $type, 'message' => $message]);
    }
}
