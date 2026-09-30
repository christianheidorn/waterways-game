<?php

namespace App\Mcp\Tools;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Storage;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('create_request')]
#[Description('Creates a request on a map as the agent, shown in the editor\'s Request tool with its outline drawn on the terrain: e.g. to ask the user something about an area ("Should the road go here or along the river?"), or to propose work for them to confirm. `note` is the title / description, `message` your question, `area` the outline (≥ 3 points in world metres) or `center` + `radius` for a circle. status "needs_input" (default: waiting for the user) or "open". attach_screenshot: true stores a view of the area (camera options as take_screenshot; default: overview of the area). Follow up with list_requests / get_request.')]
class CreateRequest extends WaterwaysTool
{
    use CameraArguments;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            'note' => $schema->string()->required(),
            'message' => $schema->string()->description('Your question or explanation for the user.'),
            'area' => $schema->array()->items($schema->object([
                'x' => $schema->number()->required(),
                'z' => $schema->number()->required(),
            ]))->description('Outline polygon in world metres (3-200 points).'),
            'center' => $schema->object([
                'x' => $schema->number()->required(),
                'z' => $schema->number()->required(),
            ])->description('Instead of area: the centre of a circular outline.'),
            'radius' => $schema->number()->min(1)->description('With center: radius in m.'),
            'status' => $schema->string()->enum(['needs_input', 'open']),
            'attach_screenshot' => $schema->boolean()->description('Store a screenshot of the area (needs the map open in an editor).'),
            ...$this->cameraSchema($schema),
        ];
    }

    protected function run(Request $request): Response
    {
        $map = $this->map($request);
        $half = $map->size / 2 + 1;
        $data = $request->validate([
            'note' => ['required', 'string', 'max:5000'],
            'message' => ['nullable', 'string', 'max:5000'],
            'area' => ['required_without:center', 'array', 'min:3', 'max:200'],
            'area.*.x' => ['required', 'numeric', "between:-{$half},{$half}"],
            'area.*.z' => ['required', 'numeric', "between:-{$half},{$half}"],
            'center' => ['required_without:area', 'array'],
            'center.x' => ['required_with:center', 'numeric', "between:-{$half},{$half}"],
            'center.z' => ['required_with:center', 'numeric', "between:-{$half},{$half}"],
            'radius' => ['required_with:center', 'numeric', 'min:1'],
            'status' => ['sometimes', 'in:needs_input,open'],
            'attach_screenshot' => ['sometimes', 'boolean'],
        ]);

        $points = $data['area'] ?? array_map(fn (int $i) => [
            'x' => (float) $data['center']['x'] + cos($i * M_PI / 8) * (float) $data['radius'],
            'z' => (float) $data['center']['z'] + sin($i * M_PI / 8) * (float) $data['radius'],
        ], range(0, 15));
        $points = array_map(fn ($p) => [
            'x' => round(max(-$half, min($half, (float) $p['x'])), 2),
            'z' => round(max(-$half, min($half, (float) $p['z'])), 2),
        ], $points);

        $agentRequest = $map->agentRequests()->create([
            'note' => $data['note'],
            'area' => $points,
            'status' => $data['status'] ?? 'needs_input',
            'agent_message' => $data['message'] ?? null,
        ]);

        if ($data['attach_screenshot'] ?? false) {
            $camera = $this->cameraPayload($request);

            if ($camera === []) {
                $xs = array_column($points, 'x');
                $zs = array_column($points, 'z');
                $extent = max(max($xs) - min($xs), max($zs) - min($zs), 20);
                $camera = ['view' => 'overview', 'look_at' => ['x' => array_sum($xs) / count($xs), 'z' => array_sum($zs) / count($zs)], 'height' => $extent * 0.9];
            }

            $shot = $this->bridge()->run($map, 'screenshot', [...$camera, 'max_width' => 1280, 'keep_camera' => false], timeout: 60);
            $path = $agentRequest->directory().'/view.jpg';
            Storage::disk('public')->put($path, base64_decode((string) ($shot['image'] ?? '')));
            $agentRequest->update(['screenshot_path' => $path, 'camera' => $shot['camera'] ?? null]);
        }

        $this->bridge()->notify($map, 'refresh', ['parts' => ['requests']]);

        return $this->json([
            'id' => $agentRequest->id,
            'map' => $map->slug,
            'status' => $agentRequest->status,
            'bounds' => $agentRequest->bounds(),
            'tip' => 'The user sees it in the editor (Request tool, key 6). Check back with get_request.',
        ]);
    }
}
