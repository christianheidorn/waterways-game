<?php

namespace App\Mcp\Tools;

use App\Support\Updates\EngineUpdater;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_engine')]
#[Description('Updates this Waterways checkout from its upstream branch (like `php artisan waterways:update`), e.g. after an engine change you requested was merged. `check: true` only fetches and says whether updates are available; `dry_run: true` shows the plan. An update snapshots every map, runs `git pull --ff-only`, then composer install / migrations / npm ci / npm run build as far as the changed files need them, and reloads open editors (hidden ones are reopened). Refuses on uncommitted local changes unless `force: true` (ask the user first). On failure it rolls back to the previous commit and rebuilds. When `mcp_server_changed` is true, reconnect the Waterways MCP server before calling more tools.')]
class UpdateEngine extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'check' => $schema->boolean()->description('Only check for updates (git fetch), change nothing.'),
            'dry_run' => $schema->boolean()->description('Show what the update would run, change nothing.'),
            'force' => $schema->boolean()->description('Update even with uncommitted local changes (no automatic rollback then). Ask the user first.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $updater = app(EngineUpdater::class);

        $result = $request->get('check') === true
            ? $updater->check()
            : $updater->update($request->get('force') === true, $request->get('dry_run') === true);

        $text = (string) json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        return in_array($result['status'], ['failed', 'refused'], true) ? Response::error($text) : Response::text($text);
    }
}
