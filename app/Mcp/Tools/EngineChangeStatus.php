<?php

namespace App\Mcp\Tools;

use App\Support\Updates\EngineChanges;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('engine_change_status')]
#[Description('State of an engine change requested with request_engine_change (via the gh CLI): with `issue` the issue (state, last comment, e.g. a question from the GitHub Action) and its pull requests (open / merged, checks passing / failing / pending, review decision) plus what to do next; with `pull_request` that PR; with neither the open PRs. When a PR is merged, run update_engine. Poll every few minutes at most.')]
#[IsReadOnly]
class EngineChangeStatus extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'issue' => $schema->integer()->description('Issue number returned by request_engine_change.'),
            'pull_request' => $schema->integer()->description('Pull request number.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $issue = $request->get('issue');
        $pr = $request->get('pull_request');

        return $this->json(app(EngineChanges::class)->status(
            $issue === null ? null : (int) $issue,
            $pr === null ? null : (int) $pr,
        ));
    }
}
