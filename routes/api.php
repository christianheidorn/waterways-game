<?php

use App\Http\Controllers\Api\MapDataController;
use Illuminate\Support\Facades\Route;

Route::prefix('maps/{map}')->name('api.maps.')->group(function () {
    Route::get('manifest', [MapDataController::class, 'manifest'])->name('manifest');
    Route::get('status', [MapDataController::class, 'status'])->name('status');
    Route::get('assets/{asset}', [MapDataController::class, 'show'])->name('assets.show');
    Route::put('assets/{asset}', [MapDataController::class, 'update'])->name('assets.update');
    Route::patch('meta', [MapDataController::class, 'updateMeta'])->name('meta.update');
    Route::post('thumbnail', [MapDataController::class, 'storeThumbnail'])->name('thumbnail.store');
});
