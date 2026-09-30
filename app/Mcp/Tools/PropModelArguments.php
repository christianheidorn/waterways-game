<?php

namespace App\Mcp\Tools;

use App\Models\PropModel;
use Illuminate\Validation\ValidationException;

/** Resolves prop model references (ids or names) to ready library models. */
trait PropModelArguments
{
    /**
     * @param  array<int, int|string>  $refs
     * @return array<int, PropModel> keyed by the given reference
     */
    protected function resolvePropModels(array $refs, string $key = 'models'): array
    {
        $models = [];

        foreach ($refs as $ref) {
            $model = is_numeric($ref)
                ? PropModel::query()->find((int) $ref)
                : PropModel::query()->whereRaw('lower(name) = ?', [mb_strtolower((string) $ref)])->first();

            if ($model === null) {
                throw ValidationException::withMessages([$key => "No prop model \"{$ref}\". See list_prop_models."]);
            }

            if (! $model->isReady()) {
                throw ValidationException::withMessages([$key => "The prop model \"{$model->name}\" is not ready yet (see get_asset_status)."]);
            }

            $models[(string) $ref] = $model;
        }

        return $models;
    }
}
