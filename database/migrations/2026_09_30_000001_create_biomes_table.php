<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('biomes', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('description')->nullable();
            // Identifies a starter biome (App\Support\StarterBiomes) so it is never duplicated.
            $table->string('starter_key')->nullable()->unique();
            // Terrain layer look: material, colours, roughness, tint, … (see Biome::LOOK).
            $table->json('look');
            // [{foliage_type_id, density, clustering, spacing}], as on terrain layers.
            $table->json('ground_cover');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('biomes');
    }
};
