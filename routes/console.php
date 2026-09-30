<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Hidden editors of AI agents (open_editor) close when idle. They also check this on their own polls
// and on each MCP tool call, so this only matters when the scheduler runs (`php artisan schedule:work`).
Schedule::command('waterways:headless stop --idle')->everyMinute()->withoutOverlapping();
