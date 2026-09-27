<?php

namespace App\Http\Controllers;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\ApplyLandCover;
use App\Models\Map;
use App\Services\LandCover\LandCoverMapping;
use App\Services\LandCover\LandCoverService;
use App\Services\LandCover\WorldCoverClasses;
use Closure;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Real-world land cover (ESA WorldCover) → terrain paint for real-world maps.
 */
class LandCoverController extends Controller
{
    /**
     * Re-paint the splat map from land cover (re-fetching it when missing).
     */
    public function apply(Request $request, Map $map): RedirectResponse
    {
        if ($error = $this->unavailable($map)) {
            return $this->reject($request, $error);
        }

        ApplyLandCover::dispatch($map);

        $this->toast('info', 'Painting terrain from land cover…');

        return back();
    }

    /**
     * Change which layer slot each land cover class is painted with, then re-paint.
     */
    public function updateMapping(Request $request, Map $map, LandCoverService $landCover): RedirectResponse
    {
        if ($error = $this->unavailable($map)) {
            return $this->reject($request, $error);
        }

        $slots = $map->layers()->pluck('slot')->map(fn ($slot) => (int) $slot)->all();

        $data = $request->validate([
            'mapping' => ['required', 'array', function (string $attribute, mixed $value, Closure $fail) {
                foreach (array_keys((array) $value) as $class) {
                    if (! is_numeric($class) || ! in_array((int) $class, WorldCoverClasses::CODES, true)) {
                        $fail("Unknown land cover class [{$class}].");
                    }
                }
            }],
            'mapping.*' => ['present', 'nullable', 'integer', 'between:0,7', Rule::in($slots)],
        ]);

        $texts = $landCover->slotTexts($map);
        $mapping = $landCover->mapping($map, $texts);
        $defaults = LandCoverMapping::defaults($texts);

        foreach ($data['mapping'] as $class => $slot) {
            $mapping[(int) $class] = $slot === null ? $defaults[(int) $class] : (int) $slot;
        }

        $map->update(['landcover_mapping' => $mapping]);

        ApplyLandCover::dispatch($map);

        $this->toast('success', 'Land cover mapping saved — repainting terrain…');

        return back();
    }

    private function unavailable(Map $map): ?string
    {
        return match (true) {
            $map->source !== MapSource::RealWorld => 'Land cover is only available for real-world maps.',
            $map->terrain_status !== TerrainStatus::Ready => 'Terrain is still being generated.',
            default => null,
        };
    }

    private function reject(Request $request, string $message): RedirectResponse
    {
        abort_if($request->expectsJson(), 422, $message);

        $this->toast('error', $message);

        return back();
    }
}
