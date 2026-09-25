<?php

use App\Http\Controllers\FoliageTypeController;
use App\Http\Controllers\GameSettingsController;
use App\Http\Controllers\MapController;
use App\Http\Controllers\MapEnvironmentController;
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

    Route::get('environment', [MapEnvironmentController::class, 'edit'])->name('environment.edit');
    Route::put('environment', [MapEnvironmentController::class, 'update'])->name('environment.update');

    Route::get('layers', [TerrainLayerController::class, 'index'])->name('layers.index');
    Route::post('layers', [TerrainLayerController::class, 'store'])->name('layers.store');
    Route::post('layers/reset', [TerrainLayerController::class, 'reset'])->name('layers.reset');
    Route::put('layers/{layer}', [TerrainLayerController::class, 'update'])->name('layers.update');
    Route::delete('layers/{layer}', [TerrainLayerController::class, 'destroy'])->name('layers.destroy');
    Route::post('layers/{layer}/texture', [TerrainLayerController::class, 'uploadTexture'])->name('layers.texture.store');
    Route::delete('layers/{layer}/texture', [TerrainLayerController::class, 'removeTexture'])->name('layers.texture.destroy');
});

Route::get('game/{map}', [StudioController::class, 'game'])->name('game.show');

Route::get('foliage', [FoliageTypeController::class, 'index'])->name('foliage.index');
Route::post('foliage', [FoliageTypeController::class, 'store'])->name('foliage.store');
Route::put('foliage/{foliageType}', [FoliageTypeController::class, 'update'])->name('foliage.update');
Route::delete('foliage/{foliageType}', [FoliageTypeController::class, 'destroy'])->name('foliage.destroy');
Route::post('foliage/{foliageType}/model', [FoliageTypeController::class, 'uploadModel'])->name('foliage.model.store');
Route::delete('foliage/{foliageType}/model', [FoliageTypeController::class, 'removeModel'])->name('foliage.model.destroy');

Route::redirect('settings', '/settings/game/player');
Route::get('settings/game/{group}', [GameSettingsController::class, 'edit'])->name('game-settings.edit');
Route::put('settings/game/{group}', [GameSettingsController::class, 'update'])->name('game-settings.update');
Route::delete('settings/game/{group}', [GameSettingsController::class, 'reset'])->name('game-settings.reset');
Route::inertia('settings/appearance', 'settings/appearance')->name('appearance.edit');
