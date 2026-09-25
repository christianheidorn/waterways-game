<?php

namespace App\Http\Controllers;

use App\Support\GameSettingsRepository;
use App\Support\GameSettingsSchema;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class GameSettingsController extends Controller
{
    public function __construct(private readonly GameSettingsRepository $settings) {}

    public function edit(string $group): Response
    {
        $schema = GameSettingsSchema::group($group) ?? abort(404);

        return Inertia::render('game-settings/edit', [
            'group' => $schema->toArray(),
            'values' => $this->settings->get($group),
            'groups' => collect(GameSettingsSchema::groups())->map(fn ($g) => ['key' => $g->key, 'title' => $g->title])->values(),
        ]);
    }

    public function update(Request $request, string $group): RedirectResponse
    {
        $schema = GameSettingsSchema::group($group) ?? abort(404);

        $this->settings->update($group, $request->validate($schema->rules()));

        $this->toast('success', "{$schema->title} settings saved.");

        return back();
    }

    public function reset(string $group): RedirectResponse
    {
        $schema = GameSettingsSchema::group($group) ?? abort(404);

        $this->settings->reset($group);

        $this->toast('success', "{$schema->title} settings reset to defaults.");

        return back();
    }
}
