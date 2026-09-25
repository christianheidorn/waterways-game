<?php

namespace App\Http\Controllers;

use App\Models\FoliageType;
use App\Models\Map;
use App\Support\EnvironmentDefaults;
use App\Support\GameSettingsRepository;
use App\Support\GameSettingsSchema;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The creator dashboard, the editor workspace (studio shell around the game iframe) and the game page itself.
 */
class StudioController extends Controller
{
    public function dashboard(): Response
    {
        $maps = Map::query()->latest('updated_at')->get();

        return Inertia::render('dashboard', [
            'maps' => $maps->map(fn (Map $map) => MapController::summary($map))->values(),
            'stats' => [
                'maps' => $maps->count(),
                'foliageTypes' => FoliageType::query()->count(),
                'realWorldMaps' => $maps->where('source.value', 'real_world')->count(),
            ],
        ]);
    }

    public function launch(): RedirectResponse
    {
        $map = Map::query()->where('is_default', true)->first() ?? Map::query()->first();

        return $map ? to_route('maps.editor', $map) : to_route('maps.create');
    }

    public function editor(Request $request, Map $map, GameSettingsRepository $settings): Response
    {
        return Inertia::render('maps/editor', [
            'map' => MapController::summary($map),
            'maps' => Map::query()->orderBy('name')->get(['id', 'name', 'slug'])->values(),
            'mode' => $request->query('mode') === 'play' ? 'play' : 'edit',
            'gameUrl' => route('game.show', $map),
            'environment' => $map->resolvedEnvironment(),
            'environmentGroup' => EnvironmentDefaults::group()->toArray(),
            'settings' => $settings->all(),
            'settingsGroups' => collect(GameSettingsSchema::groups())->map->toArray()->values(),
        ]);
    }

    /**
     * The standalone game page loaded inside the editor iframe (or full screen for play testing).
     */
    public function game(Request $request, Map $map): View
    {
        return view('game', [
            'map' => $map,
            'config' => [
                'mapSlug' => $map->slug,
                'manifestUrl' => route('api.maps.manifest', $map),
                'statusUrl' => route('api.maps.status', $map),
                'mode' => $request->query('mode') === 'play' ? 'play' : 'edit',
                'embedded' => $request->boolean('embedded'),
                'studioUrl' => route('maps.editor', $map),
                'csrfToken' => csrf_token(),
            ],
        ]);
    }
}
