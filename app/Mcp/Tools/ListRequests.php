<?php

namespace App\Mcp\Tools;

use App\Models\AgentRequest;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_requests')]
#[Description('Build requests the user made in the editor (Request tool): an outlined area of a map plus a note of what to build there, reference images and a screenshot of their view. Lists open ones by default (all maps unless `map` is given). Work on one with get_request, then report with update_request.')]
#[IsReadOnly]
class ListRequests extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $schema->string()->description('Only this map (slug or id).'),
            'status' => $schema->string()->enum(['open', 'active', 'all'])->description('open (default): waiting for an agent; active: open, in_progress or needs_input; all.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $status = $request->get('status', 'open');
        $query = AgentRequest::query()->with('map:id,slug,name')->latest('id');

        if ($request->get('map')) {
            $query->where('map_id', $this->map($request)->id);
        }

        match ($status) {
            'open' => $query->where('status', 'open'),
            'active' => $query->whereIn('status', ['open', 'in_progress', 'needs_input']),
            default => null,
        };

        return $this->json($query->limit(50)->get()->map(fn (AgentRequest $r) => [
            'id' => $r->id,
            'map' => $r->map->slug,
            'status' => $r->status,
            'title' => $r->title(),
            'area' => $r->bounds(),
            'references' => count($r->reference_paths ?? []),
            'created_at' => $r->created_at?->toIso8601String(),
            'agent_message' => $r->agent_message,
        ])->values());
    }
}
