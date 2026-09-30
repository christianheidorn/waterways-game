<?php

use App\Http\Controllers\Api\AgentBridgeController;
use App\Http\Controllers\Api\AgentRequestController;
use App\Http\Controllers\Api\AiController;
use App\Http\Controllers\Api\BiomeApiController;
use App\Http\Controllers\Api\FoliageAiController;
use App\Http\Controllers\Api\FoliageAssetApiController;
use App\Http\Controllers\Api\FoliageTypeApiController;
use App\Http\Controllers\Api\MapAiController;
use App\Http\Controllers\Api\MapDataController;
use App\Http\Controllers\Api\MaterialApiController;
use App\Http\Controllers\Api\TerrainLayerApiController;
use Illuminate\Support\Facades\Route;

Route::prefix('maps/{map}')->name('api.maps.')->group(function () {
    Route::get('manifest', [MapDataController::class, 'manifest'])->name('manifest');
    Route::get('status', [MapDataController::class, 'status'])->name('status');
    Route::get('assets/{asset}', [MapDataController::class, 'show'])->name('assets.show');
    Route::put('assets/{asset}', [MapDataController::class, 'update'])->name('assets.update');
    Route::patch('meta', [MapDataController::class, 'updateMeta'])->name('meta.update');
    Route::post('layers/{layer}/biome', [BiomeApiController::class, 'apply'])->name('layers.biome');
    Route::patch('layers/{layer}/ground-cover', [TerrainLayerApiController::class, 'groundCover'])->name('layers.ground-cover');
    Route::get('agent-requests', [AgentRequestController::class, 'index'])->name('agent-requests.index');
    Route::post('agent-requests', [AgentRequestController::class, 'store'])->name('agent-requests.store');
    Route::patch('agent-requests/{agentRequest}', [AgentRequestController::class, 'update'])->name('agent-requests.update');
    Route::delete('agent-requests/{agentRequest}', [AgentRequestController::class, 'destroy'])->name('agent-requests.destroy');
    Route::post('agent/poll', [AgentBridgeController::class, 'poll'])->name('agent.poll');
    Route::post('agent/commands/{command}', [AgentBridgeController::class, 'complete'])->name('agent.complete');
    Route::post('thumbnail', [MapDataController::class, 'storeThumbnail'])->name('thumbnail.store');

    Route::post('ai/suggest-materials', [MapAiController::class, 'suggestMaterials'])->name('ai.suggest-materials');
    Route::post('ai/review', [MapAiController::class, 'review'])->name('ai.review');
    Route::post('ai/apply-changes', [MapAiController::class, 'applyChanges'])->name('ai.apply-changes');
});

Route::post('biomes', [BiomeApiController::class, 'store'])->name('api.biomes.store');

Route::get('materials/browse/{source}', [MaterialApiController::class, 'browse'])->name('api.materials.browse');
Route::get('materials/{material}', [MaterialApiController::class, 'show'])->name('api.materials.show');

Route::get('ai/models', [AiController::class, 'models'])->name('api.ai.models');
Route::get('ai/credits', [AiController::class, 'credits'])->name('api.ai.credits');
Route::post('ai/enhance-prompt', [AiController::class, 'enhancePrompt'])->name('api.ai.enhance-prompt');

Route::get('foliage/assets/{asset}', [FoliageAssetApiController::class, 'show'])->name('api.foliage.assets.show');
Route::post('foliage/assets/{asset}/bake', [FoliageAssetApiController::class, 'bake'])->name('api.foliage.assets.bake');
Route::post('foliage/assets/{asset}/bake-failed', [FoliageAssetApiController::class, 'bakeFailed'])->name('api.foliage.assets.bake-failed');
Route::post('foliage/ai/plan', [FoliageAiController::class, 'plan'])->name('api.foliage.ai.plan');
Route::patch('foliage-types/{foliageType}', [FoliageTypeApiController::class, 'update'])->name('api.foliage-types.update');
