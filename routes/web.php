<?php

use App\Http\Controllers\AiSettingsController;
use App\Http\Controllers\CharacterController;
use App\Http\Controllers\FoliageAiController;
use App\Http\Controllers\FoliageAssetController;
use App\Http\Controllers\FoliageTypeController;
use App\Http\Controllers\GameSettingsController;
use App\Http\Controllers\LandCoverController;
use App\Http\Controllers\MapAiController;
use App\Http\Controllers\MapController;
use App\Http\Controllers\MapEnvironmentController;
use App\Http\Controllers\MaterialController;
use App\Http\Controllers\StudioController;
use App\Http\Controllers\TerrainLayerController;
use Illuminate\Support\Facades\Route;

Route::redirect('/', '/dashboard')->name('home');
Route::get('dashboard', [StudioController::class, 'dashboard'])->name('dashboard');
Route::get('studio', [StudioController::class, 'launch'])->name('studio');

Route::resource('maps', MapController::class)->except(['edit']);
Route::prefix('maps/{map}')->name('maps.')->group(function () {
    Route::get('editor', [StudioController::class, 'editor'])->name('editor');
    Route::post('regenerate', [MapController::class, 'regenerate'])->name('regenerate');
    Route::post('default', [MapController::class, 'makeDefault'])->name('default');
    Route::post('landcover', [LandCoverController::class, 'apply'])->name('landcover.apply');
    Route::put('landcover-mapping', [LandCoverController::class, 'updateMapping'])->name('landcover.mapping');

    Route::get('environment', [MapEnvironmentController::class, 'edit'])->name('environment.edit');
    Route::put('environment', [MapEnvironmentController::class, 'update'])->name('environment.update');

    Route::get('layers', [TerrainLayerController::class, 'index'])->name('layers.index');
    Route::post('layers', [TerrainLayerController::class, 'store'])->name('layers.store');
    Route::post('layers/reset', [TerrainLayerController::class, 'reset'])->name('layers.reset');
    Route::put('layers/{layer}', [TerrainLayerController::class, 'update'])->name('layers.update');
    Route::delete('layers/{layer}', [TerrainLayerController::class, 'destroy'])->name('layers.destroy');
    Route::post('layers/{layer}/texture', [TerrainLayerController::class, 'uploadTexture'])->name('layers.texture.store');
    Route::delete('layers/{layer}/texture', [TerrainLayerController::class, 'removeTexture'])->name('layers.texture.destroy');
    Route::put('layers/{layer}/material', [TerrainLayerController::class, 'assignMaterial'])->name('layers.material');

    Route::post('ai/apply-suggestion', [MapAiController::class, 'applySuggestion'])->name('ai.apply-suggestion');
});

Route::get('materials', [MaterialController::class, 'index'])->name('materials.index');
Route::post('materials/upload', [MaterialController::class, 'upload'])->name('materials.upload');
Route::post('materials/import', [MaterialController::class, 'import'])->name('materials.import');
Route::post('materials/generate', [MaterialController::class, 'generate'])->name('materials.generate');
Route::post('materials/{material}/ai-edit', [MaterialController::class, 'aiEdit'])->name('materials.ai-edit');
Route::post('materials/{material}/retry', [MaterialController::class, 'retry'])->name('materials.retry');
Route::post('materials/{material}/duplicate', [MaterialController::class, 'duplicate'])->name('materials.duplicate');
Route::put('materials/{material}', [MaterialController::class, 'update'])->name('materials.update');
Route::delete('materials/{material}', [MaterialController::class, 'destroy'])->name('materials.destroy');

Route::get('game/{map}', [StudioController::class, 'game'])->name('game.show');

Route::get('characters', [CharacterController::class, 'index'])->name('characters.index');
Route::post('characters/generate', [CharacterController::class, 'generate'])->name('characters.generate');
Route::post('characters/upload', [CharacterController::class, 'upload'])->name('characters.upload');
Route::delete('characters/active', [CharacterController::class, 'deactivate'])->name('characters.deactivate');
Route::put('characters/{character}', [CharacterController::class, 'update'])->name('characters.update');
Route::post('characters/{character}/activate', [CharacterController::class, 'activate'])->name('characters.activate');
Route::post('characters/{character}/retry', [CharacterController::class, 'retry'])->name('characters.retry');
Route::delete('characters/{character}', [CharacterController::class, 'destroy'])->name('characters.destroy');

Route::get('foliage', [FoliageTypeController::class, 'index'])->name('foliage.index');
Route::post('foliage/assets/upload', [FoliageAssetController::class, 'upload'])->name('foliage.assets.upload');
Route::post('foliage/assets/generate', [FoliageAssetController::class, 'generate'])->name('foliage.assets.generate');
Route::put('foliage/assets/{asset}', [FoliageAssetController::class, 'update'])->name('foliage.assets.update');
Route::post('foliage/assets/{asset}/rebake', [FoliageAssetController::class, 'rebake'])->name('foliage.assets.rebake');
Route::post('foliage/assets/{asset}/retry', [FoliageAssetController::class, 'retry'])->name('foliage.assets.retry');
Route::post('foliage/assets/{asset}/create-type', [FoliageAssetController::class, 'createType'])->name('foliage.assets.create-type');
Route::delete('foliage/assets/{asset}', [FoliageAssetController::class, 'destroy'])->name('foliage.assets.destroy');
Route::post('foliage/ai/apply', [FoliageAiController::class, 'apply'])->name('foliage.ai.apply');
Route::post('foliage', [FoliageTypeController::class, 'store'])->name('foliage.store');
Route::put('foliage/{foliageType}', [FoliageTypeController::class, 'update'])->name('foliage.update');
Route::delete('foliage/{foliageType}', [FoliageTypeController::class, 'destroy'])->name('foliage.destroy');
Route::post('foliage/{foliageType}/model', [FoliageTypeController::class, 'uploadModel'])->name('foliage.model.store');
Route::delete('foliage/{foliageType}/model', [FoliageTypeController::class, 'removeModel'])->name('foliage.model.destroy');

Route::redirect('settings', '/settings/game/player');
Route::get('settings/game/{group}', [GameSettingsController::class, 'edit'])->name('game-settings.edit');
Route::put('settings/game/{group}', [GameSettingsController::class, 'update'])->name('game-settings.update');
Route::delete('settings/game/{group}', [GameSettingsController::class, 'reset'])->name('game-settings.reset');
Route::get('settings/ai', [AiSettingsController::class, 'edit'])->name('ai-settings.edit');
Route::put('settings/ai', [AiSettingsController::class, 'update'])->name('ai-settings.update');
Route::post('settings/ai/test', [AiSettingsController::class, 'test'])->name('ai-settings.test');
Route::inertia('settings/appearance', 'settings/appearance')->name('appearance.edit');
