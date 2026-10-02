<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use App\Support\Updates\EngineChanges;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('request_engine_change')]
#[Description('Asks for a change to the engine / editor / MCP code (not map content) when the tools cannot do what the work needs: files a GitHub issue mentioning @claude, which the Claude GitHub Action implements on a branch and opens as a PR for review (docs/AUTONOMY.md). Uses the gh CLI when it is installed and logged in; otherwise (or with `create: false`) it returns the issue text and a prefilled URL to open. Write it for a developer who has never seen this map: `goal` (what should become possible), `context` (what you tried, tool names, errors), `acceptance` (checkable criteria), `references` (map slugs, coordinates, screenshot paths), `priority`. Before filing, try to work around it with existing tools; file one issue per change. Then poll engine_change_status and run update_engine after the merge.')]
class RequestEngineChange extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'goal' => $schema->string()->required()->description('What should become possible, in one or two sentences.'),
            'title' => $schema->string()->description('Issue title (default: derived from the goal).'),
            'context' => $schema->string()->description('Why it is needed, what you tried, tool names and error messages.'),
            'acceptance' => $schema->array()->items($schema->string())->description('Acceptance criteria, each checkable (e.g. "edit_water accepts `depth` and the lake is that deep").'),
            'references' => $schema->array()->items($schema->string())->description('Map slugs, coordinates, screenshot file paths or URLs that show the problem.'),
            'priority' => $schema->string()->enum(['low', 'normal', 'high', 'blocking'])->description('How urgently the work needs it (default normal; "blocking" = the map work cannot continue).'),
            'create' => $schema->boolean()->description('Create the issue with gh (default true). false returns the draft only.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $goal = trim((string) $request->get('goal'));

        if ($goal === '') {
            throw new ToolError('Give the `goal`: what should become possible.');
        }

        return $this->json(app(EngineChanges::class)->request([
            'goal' => $goal,
            'title' => $request->get('title'),
            'context' => $request->get('context'),
            'acceptance' => array_values((array) ($request->get('acceptance') ?? [])),
            'references' => array_values((array) ($request->get('references') ?? [])),
            'priority' => $request->get('priority'),
        ], $request->get('create') !== false));
    }
}
