<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('terrain_layers', function (Blueprint $table) {
            // [{foliage_type_id, density}]: foliage that grows by itself wherever the layer is painted.
            $table->json('ground_cover')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('terrain_layers', function (Blueprint $table) {
            $table->dropColumn('ground_cover');
        });
    }
};
