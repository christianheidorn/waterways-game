<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Mcp\EditorBridge;
use App\Models\AgentCommand;
use App\Models\Map;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The open editor's side of the agent bridge: it polls for queued commands and reports results.
 */
class AgentBridgeController extends Controller
{
    public function __construct(private readonly EditorBridge $bridge) {}

    public function poll(Request $request, Map $map): JsonResponse
    {
        $data = $request->validate([
            'session' => ['required', 'string', 'max:64'],
            'mode' => ['required', 'in:edit,play'],
            'state' => ['nullable', 'array'],
        ]);

        return response()->json([
            'commands' => $this->bridge->poll($map, $data['session'], $data['mode'], $data['state'] ?? null),
        ]);
    }

    public function complete(Request $request, Map $map, AgentCommand $command): JsonResponse
    {
        abort_unless($command->map_id === $map->id, 404);

        $data = $request->validate([
            'ok' => ['required', 'boolean'],
            'result' => ['nullable'],
            'error' => ['nullable', 'string', 'max:2000'],
        ]);

        $this->bridge->complete($command, $data['ok'], $data['result'] ?? null, $data['error'] ?? null);

        return response()->json(['ok' => true]);
    }
}
