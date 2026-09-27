<?php

use App\Http\Controllers\Api\AiController;
use App\Http\Controllers\Api\MapAiController;
use App\Http\Controllers\Api\MapDataController;
use App\Http\Controllers\Api\MaterialApiController;
use Illuminate\Support\Facades\Route;

Route::prefix('maps/{map}')->name('api.maps.')->group(function () {
    Route::get('manifest', [MapDataController::class, 'manifest'])->name('manifest');
    Route::get('status', [MapDataController::class, 'status'])->name('status');
    Route::get('assets/{asset}', [MapDataController::class, 'show'])->name('assets.show');
    Route::put('assets/{asset}', [MapDataController::class, 'update'])->name('assets.update');
    Route::patch('meta', [MapDataController::class, 'updateMeta'])->name('meta.update');
    Route::post('thumbnail', [MapDataController::class, 'storeThumbnail'])->name('thumbnail.store');

    Route::post('ai/suggest-materials', [MapAiController::class, 'suggestMaterials'])->name('ai.suggest-materials');
    Route::post('ai/review', [MapAiController::class, 'review'])->name('ai.review');
    Route::post('ai/apply-changes', [MapAiController::class, 'applyChanges'])->name('ai.apply-changes');
});

Route::get('materials/browse/{source}', [MaterialApiController::class, 'browse'])->name('api.materials.browse');
Route::get('materials/{material}', [MaterialApiController::class, 'show'])->name('api.materials.show');

Route::get('ai/models', [AiController::class, 'models'])->name('api.ai.models');
Route::post('ai/enhance-prompt', [AiController::class, 'enhancePrompt'])->name('api.ai.enhance-prompt');
