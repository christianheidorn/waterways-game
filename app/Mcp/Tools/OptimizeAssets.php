<?php

namespace App\Mcp\Tools;

use App\Mcp\Assets\AssetOptimizer;
use App\Mcp\ToolError;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('optimize_assets')]
#[Description(<<<'TXT'
Compresses library models for the game, like `php artisan waterways:optimize-assets`: foliage assets and prop models get a copy next to the original with EXT_meshopt_compression meshes (lossless, typically 20–40 % smaller geometry) and KTX2 / Basis textures (they stay compressed on the GPU: about 4× less texture memory; the file can be larger than well-compressed PNGs). The game loads the copy and falls back to the original; a re-bake or re-import makes the copy stale until it is optimised again.
Texture encoding takes about a minute per model, so the call handles at most `limit` models (default 3) and reports the rest as pending: call again, or pass `textures: false` for a fast meshes-only pass. `dry_run: true` only reports what is optimised, pending, and which foliage assets still have the old single-card impostor (`impostor: "billboard"`: re-bake them with bake_foliage_asset for octahedral impostors).
Returns per model the status and sizes (file, textures, estimated GPU texture memory before / after) and the totals.
TXT)]
class OptimizeAssets extends WaterwaysTool
{
    public function schema(JsonSchema $schema): array
    {
        return [
            'kind' => $schema->string()->enum(['all', 'foliage', 'props'])->description('Which library (default all).'),
            'ids' => $schema->array()->items($schema->integer())->description('Only these ids (foliage asset or prop model ids; needs kind foliage or props).'),
            'textures' => $schema->boolean()->description('Convert textures to KTX2 (default true; slow).'),
            'meshes' => $schema->boolean()->description('Meshopt-compress the meshes (default true; fast).'),
            'force' => $schema->boolean()->description('Optimise again even when the copy is up to date.'),
            'dry_run' => $schema->boolean()->description('Only report (default false).'),
            'limit' => $schema->integer()->min(1)->max(50)->description('Models optimised in this call (default 3); the rest are reported as pending.'),
        ];
    }

    protected function run(Request $request): Response
    {
        $data = Validator::make($request->all(), [
            'kind' => ['sometimes', 'in:all,foliage,props'],
            'ids' => ['sometimes', 'array'],
            'ids.*' => ['integer'],
            'limit' => ['sometimes', 'integer', 'between:1,50'],
        ])->validate();

        $kind = $data['kind'] ?? 'all';
        $ids = $data['ids'] ?? null;

        if ($ids !== null && $kind === 'all') {
            throw new ToolError('Pass kind "foliage" or "props" with ids.');
        }

        $optimizer = app(AssetOptimizer::class);
        $options = [
            'textures' => (bool) $request->get('textures', true),
            'meshes' => (bool) $request->get('meshes', true),
            'force' => (bool) $request->get('force', false),
        ];

        // Plan first, then optimise the first `limit` pending models.
        $rows = $optimizer->run($kind, $ids, ...$options, dryRun: true);

        if (! $request->get('dry_run', false)) {
            $limit = (int) ($data['limit'] ?? 3);
            $work = array_values(array_filter($rows, fn ($r) => $r['status'] === 'pending' || ($options['force'] && $r['status'] === 'up_to_date')));

            foreach (array_slice($work, 0, $limit) as $row) {
                [$done] = $optimizer->run($row['kind'] === 'props' ? 'props' : 'foliage', [$row['id']], ...$options);
                foreach ($rows as $i => $r) {
                    if ($r['kind'] === $row['kind'] && $r['id'] === $row['id']) {
                        $rows[$i] = $done;
                    }
                }
            }
        }

        $summary = AssetOptimizer::summary($rows);

        return $this->json([
            'summary' => $summary,
            'models' => $rows,
            'next' => $summary['pending'] > 0
                ? "{$summary['pending']} model(s) still pending: call optimize_assets again."
                : 'Done. Open editors pick the compressed copies up on the next map load.',
        ]);
    }
}
