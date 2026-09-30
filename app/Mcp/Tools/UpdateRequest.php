<?php

namespace App\Mcp\Tools;

use App\Mcp\ToolError;
use App\Models\AgentRequest;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('update_request')]
#[Description('Reports progress on a build request; the user sees the status and message in the editor\'s Request tool. status: in_progress (you started), needs_input (you have a question: put it in `message`), done (describe what you built in `message`). attach_screenshot: true renders the area from the user\'s original camera in the open editor and stores it as a result image (or pass `camera` / `view` like take_screenshot).')]
class UpdateRequest extends WaterwaysTool
{
    use CameraArguments;

    public function schema(JsonSchema $schema): array
    {
        return [
            'id' => $schema->integer()->required(),
            'status' => $schema->string()->enum(['in_progress', 'needs_input', 'done'])->required(),
            'message' => $schema->string()->description('What you did, or your question for the user.'),
            'attach_screenshot' => $schema->boolean()->description('Store a screenshot of the result (needs the map open in an editor).'),
            ...$this->cameraSchema($schema),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = $request->validate([
            'id' => ['required', 'integer'],
            'status' => ['required', 'in:in_progress,needs_input,done'],
            'message' => ['nullable', 'string', 'max:5000'],
            'attach_screenshot' => ['sometimes', 'boolean'],
        ]);
        $agentRequest = AgentRequest::query()->with('map')->find($data['id'])
            ?? throw new ToolError('No such request. See list_requests.');
        $results = $agentRequest->result_paths ?? [];

        if ($data['attach_screenshot'] ?? false) {
            $camera = $this->cameraPayload($request);

            if ($camera === [] && isset($agentRequest->camera['position'], $agentRequest->camera['direction'])) {
                $p = $agentRequest->camera['position'];
                $d = $agentRequest->camera['direction'];
                $camera = [
                    'position' => $p,
                    'look_at' => ['x' => $p['x'] + $d['x'] * 100, 'y' => $p['y'] + $d['y'] * 100, 'z' => $p['z'] + $d['z'] * 100],
                ];
            }

            $shot = $this->bridge()->run($agentRequest->map, 'screenshot', [...$camera, 'max_width' => 1280], timeout: 60);
            $path = $agentRequest->directory().'/result-'.Str::random(6).'.jpg';
            Storage::disk('public')->put($path, base64_decode((string) ($shot['image'] ?? '')));
            $results[] = $path;
        }

        $agentRequest->update([
            'status' => $data['status'],
            'agent_message' => $data['message'] ?? $agentRequest->agent_message,
            'result_paths' => $results,
        ]);
        $this->bridge()->notify($agentRequest->map, 'refresh', ['parts' => ['requests']]);

        return $this->json(['id' => $agentRequest->id, 'status' => $agentRequest->status, 'result_images' => count($results)]);
    }
}
