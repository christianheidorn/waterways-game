<?php

namespace App\Mcp\Assets;

use App\Mcp\EditorBridge;
use App\Mcp\ToolError;
use App\Models\FoliageAsset;
use Illuminate\Support\Sleep;

/**
 * Foliage assets become usable once they are "baked" in a browser (resources/game/tools/FoliageBaker.ts:
 * LODs, impostor, thumbnail). The studio's foliage page does this by itself; for agents, any open editor
 * can do it too (the 'bake_foliage_asset' bridge command), so the user does not have to open that page.
 */
class EditorBakes
{
    public function __construct(private readonly EditorBridge $bridge) {}

    /** Whether some editor is open to bake in. */
    public function available(): bool
    {
        return $this->bridge->session()?->map !== null;
    }

    /**
     * Starts the bake in the most recently active editor and waits up to $wait seconds for it to finish.
     *
     * @return array{status: string, message: string|null, editor_map: string}
     */
    public function bake(FoliageAsset $asset, int $wait = 90): array
    {
        if ($asset->status !== 'awaiting_bake') {
            throw new ToolError("Foliage asset {$asset->id} is {$asset->status}, not waiting to be baked.".($asset->status === 'ready' ? ' It is ready to use.' : ''));
        }
        if (! $asset->canBake()) {
            throw new ToolError("Foliage asset {$asset->id} has no source file to bake. Import or generate it again.");
        }

        $map = $this->bridge->session()?->map
            ?? throw new ToolError('No editor is open to bake the asset in. Ask the user to open any map in the studio (Maps → map → Open Studio), or the Foliage page, which bakes waiting assets by itself; then call bake_foliage_asset.');

        $options = $asset->bake_options ?? [];
        $card = $asset->source_type === 'card';
        $asset->forceFill(['status_message' => 'Optimising in the open editor…'])->save();
        $this->bridge->run($map, 'bake_foliage_asset', [
            'asset_id' => $asset->id,
            'kind' => $asset->kind->value,
            'source_type' => $card ? 'card' : 'model',
            'source_url' => '/storage/'.$asset->source_path,
            'target_height' => $asset->target_height,
            ...($card ? ['key_background' => (bool) ($options['key_background'] ?? false), 'key_color' => $options['key_color'] ?? null] : []),
            'bake_url' => route('api.foliage.assets.bake', $asset, absolute: false),
            'failed_url' => route('api.foliage.assets.bake-failed', $asset, absolute: false),
        ], timeout: 30);

        for ($i = 0; $i < $wait * 2 && $asset->refresh()->status === 'awaiting_bake'; $i++) {
            Sleep::usleep(500_000);
        }

        return ['status' => $asset->status, 'message' => $asset->status_message, 'editor_map' => $map->slug];
    }
}
