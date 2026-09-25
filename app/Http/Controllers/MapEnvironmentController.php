<?php

namespace App\Http\Controllers;

use App\Models\Map;
use App\Support\EnvironmentDefaults;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class MapEnvironmentController extends Controller
{
    public function edit(Map $map): Response
    {
        return Inertia::render('maps/environment', [
            'map' => MapController::summary($map),
            'group' => EnvironmentDefaults::group()->toArray(),
            'values' => $map->resolvedEnvironment(),
        ]);
    }

    public function update(Request $request, Map $map): RedirectResponse
    {
        $group = EnvironmentDefaults::group();
        $data = $request->validate($group->rules());

        $map->update(['environment' => $group->merge([...$map->resolvedEnvironment(), ...$data])]);

        $this->toast('success', 'Environment saved.');

        return back();
    }
}
