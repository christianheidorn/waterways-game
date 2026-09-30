<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Models\AgentCommand;
use App\Models\Map;
use Closure;

/**
 * The editor's side of the bridge, simulated inside the wait loop: while a tool waits for a
 * command, this "editor" polls and answers it with the given handler.
 */
class FakeEditor extends EditorBridge
{
    /** @var list<array{type: string, payload: array<string, mixed>}> */
    public array $ran = [];

    /**
     * @param  Closure(string, array<string, mixed>): array<string, mixed>  $handler
     */
    public function __construct(private readonly Map $map, private readonly Closure $handler)
    {
        $this->poll($map, 'test-session', 'edit', ['unsaved' => []]);
    }

    protected function sleep(): void
    {
        foreach ($this->poll($this->map, 'test-session', 'edit', ['unsaved' => []]) as $command) {
            $this->ran[] = ['type' => $command['type'], 'payload' => $command['payload']];
            $this->complete(AgentCommand::query()->findOrFail($command['id']), true, ($this->handler)($command['type'], $command['payload']), null);
        }
    }
}
