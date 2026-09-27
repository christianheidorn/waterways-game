<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('materials', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('slug')->unique();
            $table->string('category')->default('other');
            // upload | polyhaven | ambientcg | ai
            $table->string('source')->default('upload');
            $table->string('source_ref')->nullable();
            $table->string('source_url')->nullable();
            $table->string('author')->nullable();
            $table->string('license')->nullable();
            $table->json('tags')->nullable();
            // Real-world size (m) of one texture repeat.
            $table->double('tile_size')->default(2);
            $table->unsignedInteger('resolution')->nullable();
            $table->string('albedo_path')->nullable();
            $table->string('normal_path')->nullable();
            $table->string('roughness_path')->nullable();
            $table->string('ao_path')->nullable();
            $table->string('height_path')->nullable();
            $table->string('thumbnail_path')->nullable();
            $table->string('tint', 9)->default('#ffffff');
            $table->double('roughness_scale')->default(1);
            $table->double('normal_strength')->default(1);
            $table->double('height_contrast')->default(1);
            // ready | processing | failed
            $table->string('status')->default('ready');
            $table->string('status_message')->nullable();
            $table->text('ai_prompt')->nullable();
            $table->string('ai_model')->nullable();
            $table->foreignId('parent_id')->nullable()->constrained('materials')->nullOnDelete();
            $table->timestamps();
        });

        Schema::table('terrain_layers', function (Blueprint $table) {
            $table->foreignId('material_id')->nullable()->after('slot')->constrained()->nullOnDelete();
            $table->string('tint', 9)->default('#ffffff');
            $table->double('roughness_scale')->default(1);
            $table->double('normal_strength')->default(1);
        });

        Schema::table('maps', function (Blueprint $table) {
            // ESA WorldCover class → terrain layer slot, e.g. {"10": 2, "30": 1}.
            $table->json('landcover_mapping')->nullable();
            $table->boolean('use_landcover')->default(true);
        });
    }

    public function down(): void
    {
        Schema::table('maps', function (Blueprint $table) {
            $table->dropColumn(['landcover_mapping', 'use_landcover']);
        });

        Schema::table('terrain_layers', function (Blueprint $table) {
            $table->dropConstrainedForeignId('material_id');
            $table->dropColumn(['tint', 'roughness_scale', 'normal_strength']);
        });

        Schema::dropIfExists('materials');
    }
};
